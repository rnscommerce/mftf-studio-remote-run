<?php
// The whole runner as one process: it answers the Run object, runs
// Codeception as its child, and holds the run's events in memory.
//   /bundle/project    Data and Metadata XML and project PHP, as a project root
//   /bundle/generated  _generated/<default or suite>/<Test>Cest.php
//   /bundle/studio     Studio's own PHP: studio-job.php and its extensions
declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Psr\Http\Message\ServerRequestInterface;
use React\ChildProcess\Process;
use React\EventLoop\Loop;
use React\Http\HttpServer;
use React\Http\Message\Response;
use React\Http\Middleware\LimitConcurrentRequestsMiddleware;
use React\Http\Middleware\RequestBodyBufferMiddleware;
use React\Http\Middleware\StreamingRequestMiddleware;
use React\Socket\SocketServer;
use React\Stream\ReadableStreamInterface;
use React\Stream\ThroughStream;

const WORKSPACE = '/work/ws';
const ALLURE = "    - Qameta\\Allure\\Codeception\\AllureCodeception\n";
// How long each hook a stop waits for is given, as Studio gives one on its own machine.
const HOOK_BUDGET_S = 60;
// How long Codeception is given to leave after the kill, which it takes as an exception and may outlast.
const KILL_GRACE_S = 10;
const HOLD_EXTENSION = 'studio-hold.php';

set_error_handler(static fn (int $level, string $message) => throw new ErrorException($message), E_ALL & ~E_DEPRECATED);

function copyTree(string $from, string $to): void
{
    if (!is_dir($to)) mkdir($to, 0777, true);
    $files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($from, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST,
    );
    foreach ($files as $file) {
        $target = "$to/{$files->getSubPathname()}";
        if ($file->isDir()) is_dir($target) || mkdir($target);
        else copy($file->getPathname(), $target);
    }
}

function removeTree(string $path): void
{
    if (is_file($path)) unlink($path);
    if (!is_dir($path)) return;
    $files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST,
    );
    foreach ($files as $file) $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
    rmdir($path);
}

// A container reaches the machine it runs on through its default gateway,
// which is where a local instance and a local stand-in browser are.
function gateway(): string
{
    foreach (array_slice(file('/proc/net/route'), 1) as $line) {
        [, $destination, $hex] = explode("\t", $line);
        if ($destination === '00000000') return long2ip(unpack('V', hex2bin($hex))[1]);
    }
    throw new RuntimeException('No default gateway');
}

// What drives the browser, as a provider's connector answers it: merged into
// the suite file's capabilities the way Studio merges them for a local run.
function useBrowser(array $capabilities): void
{
    $file = WORKSPACE . '/tests/functional.suite.yml';
    $lines = explode("\n", file_get_contents($file));
    $at = array_key_first(preg_grep('/^\s*capabilities:\s*$/', $lines));
    $indent = str_repeat(' ', strspn($lines[$at], ' ') + 4);
    // A capability the provider names replaces the image's own, whole.
    foreach (array_keys($capabilities) as $key) {
        $own = null;
        foreach ($lines as $n => $line) {
            if ($n > $at && preg_match('/^' . $indent . '"?' . preg_quote((string) $key, '/') . '"?:/', $line)) {
                $own = $n;
                break;
            }
        }
        if ($own === null) continue;
        $end = $own + 1;
        while ($end < count($lines) && str_starts_with($lines[$end], "$indent ")) $end++;
        array_splice($lines, $own, $end - $own);
    }
    $added = [];
    foreach ($capabilities as $key => $value) {
        $added[] = $indent . json_encode((string) $key) . ': ' . json_encode($value, JSON_UNESCAPED_SLASHES);
    }
    array_splice($lines, $at + 1, 0, $added);
    file_put_contents($file, implode("\n", $lines));
    chmod($file, 0600);
}

/** Names one more extension in codeception.yml, ahead of those already there. */
function enable(string $config, string $name): string
{
    return str_replace(ALLURE, ALLURE . "    - $name\n", $config);
}

/**
 * Lays the workspace out and answers the environment Codeception runs in.
 *
 * @param array $capabilities as the request holds them, an empty object still an object
 */
function layOut(array $request, array $capabilities, string $framework): array
{
    $ws = WORKSPACE;
    $selector = $request['selector'];
    foreach ($request['hosts'] ?? [] as $name => $address) {
        file_put_contents('/etc/hosts', ($address === 'gateway' ? gateway() : $address) . " $name\n", FILE_APPEND);
    }

    copyTree(str_ends_with($request['mftf'], '-bidi') ? '/opt/workspace-bidi' : '/opt/workspace', $ws);
    useBrowser($capabilities);
    symlink($framework, "$ws/framework");
    copyTree('/bundle/project', '/work/project');
    foreach (['env', 'generated', 'tests/_output', 'tests/_data'] as $dir) mkdir("$ws/$dir", 0777, true);
    copyTree('/bundle/generated', "$ws/generated");
    file_put_contents("$ws/env/.env", $request['env']);
    file_put_contents("$ws/.credentials", $request['credentials']);
    chmod("$ws/env/.env", 0600);
    chmod("$ws/.credentials", 0600);

    $config = file_get_contents("$ws/codeception.yml");

    // The extensions Studio brings: each is a file of the bundle and the class
    // it defines, loaded before Codeception looks for the class.
    $extensions = $request['extensions'] ?? [];
    if ($extensions !== []) {
        $bootstrap = "<?php\n";
        foreach ($extensions as ['file' => $file, 'name' => $name]) {
            $bootstrap .= 'require_once ' . var_export("/bundle/studio/$file", true) . ";\n";
            $config = enable($config, $name);
        }
        file_put_contents("$ws/studio-bootstrap.php", $bootstrap);
        $config .= "bootstrap: $ws/studio-bootstrap.php\n";
    }

    // A suite is a directory under _generated. Its hooks are the group class
    // Studio keeps beside the Cests as group.php: it goes where MFTF's Group
    // namespace resolves, and codeception.yml names the group and its
    // extension. A single Cest in a suite's directory is that suite's member,
    // and runs with the same hooks.
    $dir = is_dir("$ws/$selector") ? $selector : dirname($selector);
    $suite = basename($dir);
    if (is_file("$ws/$dir/group.php") && filesize("$ws/$dir/group.php") > 0) {
        copy("$ws/$dir/group.php", "$framework/src/Magento/FunctionalTestingFramework/Group/$suite.php");
        $config = enable($config, "Group\\$suite");
        $config .= "groups:\n  $suite:\n    - $dir/\n";
    }
    file_put_contents("$ws/codeception.yml", $config);

    mkdir('/out/written', 0777, true);
    // Where Studio's hold extension says which socket the browser session
    // answers BiDi on, and where a stop is left for it to read.
    is_dir('/hold') || mkdir('/hold');
    $environment = [
        ...getenv(),
        'MFTF_STUDIO_ENV_DIR' => "$ws/env",
        'MFTF_STUDIO_TESTS_BP' => $ws,
        'MFTF_STUDIO_MODULE_PATH' => "$ws/generated",
        'MFTF_STUDIO_FRAMEWORK' => $framework,
        'MFTF_STUDIO_PROJECT' => '/work/project',
        'MFTF_STUDIO_HOLD' => '/hold',
    ];
    // What an extension writes through an environment variable is kept with
    // the run's results, under the variable's own name.
    foreach ($request['writes'] ?? [] as $name) {
        if (preg_match('/^[A-Z][A-Z0-9_]*$/', $name)) $environment[$name] = "/out/written/$name";
    }
    return $environment;
}

function writeHold(string $name, string $content): void
{
    file_put_contents("/hold/$name.tmp", $content);
    rename("/hold/$name.tmp", "/hold/$name");
}

/** Hands over each whole line a stream carries, and what is left when it closes. */
function eachLine(ReadableStreamInterface $stream, callable $on): void
{
    $rest = '';
    $stream->on('data', static function (string $chunk) use (&$rest, $on): void {
        $lines = explode("\n", $rest . $chunk);
        $rest = array_pop($lines);
        foreach ($lines as $line) $on(rtrim($line, "\r"));
    });
    $flush = static function () use (&$rest, $on): void {
        if ($rest !== '') $on($rest);
        $rest = '';
    };
    // On end first: the last pipe's close is where the process is said to
    // have exited. A read that fails closes with no end.
    $stream->on('end', $flush);
    $stream->on('close', $flush);
}

final class Run
{
    /** @var string[] every event so far, each a line of JSON */
    private array $events = [];
    /** @var ThroughStream[] */
    private array $followers = [];
    private bool $ended = false;
    private ?Process $going = null;
    private string $framework = '';
    private array $environment = [];
    // The Cest the run is on, which Codeception names before each test.
    private ?string $cest = null;
    private bool $suite = false;
    private bool $graceful = false;
    private bool $stopping = false;

    public function started(): bool
    {
        return $this->events !== [];
    }

    private function push(array $event): void
    {
        $line = json_encode(
            ['n' => count($this->events), 'at' => (int) (microtime(true) * 1000), ...$event],
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE,
        ) . "\n";
        $this->events[] = $line;
        foreach ($this->followers as [$from, $follower]) {
            if (count($this->events) > $from) $follower->write($line);
        }
    }

    private function say(string $text): void
    {
        $this->push(['type' => 'line', 'text' => $text]);
    }

    /** Hands a follower every event from `from` on, now and as they come, until the run has ended. */
    public function follow(int $from, ThroughStream $follower): void
    {
        $from = max(0, $from);
        foreach (array_slice($this->events, $from) as $line) $follower->write($line);
        if ($this->ended) {
            $follower->end();
            return;
        }
        $this->followers[spl_object_id($follower)] = [$from, $follower];
        $follower->on('close', function () use ($follower): void {
            unset($this->followers[spl_object_id($follower)]);
        });
    }

    /** Runs Codeception in a session of its own, so a kill ends it and everything under it. */
    private function codecept(array $arguments, callable $ended): Process
    {
        $command = [
            PHP_BINARY, '-d', 'auto_prepend_file=/bundle/studio/studio-job.php',
            "{$this->framework}/vendor/bin/codecept", ...$arguments, '-c', WORKSPACE . '/codeception.yml',
        ];
        $process = new Process(
            'exec setsid ' . implode(' ', array_map('escapeshellarg', $command)),
            WORKSPACE,
            $this->environment,
            [['file', '/dev/null', 'r'], ['pipe', 'w'], ['pipe', 'w']],
        );
        $process->start();
        $process->on('exit', function (?int $code) use ($ended): void {
            try {
                $ended($code);
            } catch (Throwable $error) {
                $this->fail($error);
            }
        });
        return $this->going = $process;
    }

    public function start(string $sent): void
    {
        $this->push(['type' => 'started']);
        try {
            $request = json_decode($sent, true);
            $this->framework = "/opt/mftf/{$request['mftf']}";
            if (!is_file("{$this->framework}/vendor/bin/codecept")) {
                $this->say("ERROR: the runner has no MFTF {$request['mftf']}");
                $this->end(2);
                return;
            }
            // Capabilities as the request holds them, an empty object still an object.
            $this->environment = layOut($request, (array) (json_decode($sent)->capabilities ?? []), $this->framework);
            $selector = $request['selector'];

            // The actor class Codeception generates from the suite file, which
            // no build carries: MFTF writes it in build:project alone. Only
            // what goes wrong with it is said.
            $build = $this->codecept(['build', '--no-ansi'], function (?int $code) use ($request, $selector): void {
                if ($code !== 0 || $this->stopping) {
                    $this->end($this->stopping ? null : $code);
                    return;
                }
                $this->suite = !str_ends_with($selector, 'Cest.php');
                $this->graceful = in_array(HOLD_EXTENSION, array_column($request['extensions'] ?? [], 'file'), true);
                $run = $this->codecept(['run', 'functional', $selector, '--steps', '--verbose'], function (?int $code): void {
                    copyTree(WORKSPACE . '/tests/_output', '/out');
                    if (is_file(WORKSPACE . '/mftf.log')) copy(WORKSPACE . '/mftf.log', '/out/mftf.log');
                    $this->end($code);
                });
                $said = function (string $text): void {
                    if (preg_match('~^Test: .*/([^/:]+Cest\.php):~', preg_replace('/\x1b\[[0-9;]*m/', '', $text), $named)) {
                        $this->cest = $named[1];
                    }
                    $this->say($text);
                };
                eachLine($run->stdout, $said);
                eachLine($run->stderr, $said);
            });
            eachLine($build->stderr, fn (string $text) => $this->say($text));
        } catch (Throwable $error) {
            $this->fail($error);
        }
    }

    private function fail(Throwable $error): void
    {
        if ($this->ended) return;
        $this->say("ERROR: {$error->getMessage()}");
        $this->end(1);
    }

    private function end(?int $code): void
    {
        $this->ended = true;
        try {
            removeTree(WORKSPACE . '/env');
            removeTree(WORKSPACE . '/.credentials');
        } catch (Throwable $error) {
            $this->say("ERROR: {$error->getMessage()}");
        }
        $this->push(['type' => 'ended', 'code' => $code]);
        foreach ($this->followers as [, $follower]) $follower->end();
    }

    /**
     * Ends the run where a stop asks for that.
     *
     * A stop goes by way of the run's after hooks where Studio's hold
     * extension is there to be asked: the test going now fails its next step
     * and goes on into its own hook, and a suite starts no further test and
     * runs its own after block. Past the budget, or with nothing to ask, the
     * kill is what ends it, and what is still going a little after that is
     * ended outright.
     */
    public function stop(): void
    {
        if ($this->going === null || $this->ended || $this->stopping) return;
        $this->stopping = true;
        $signal = fn (int $signal) => $this->ended || posix_kill(-$this->going->getPid(), $signal);
        $kill = function () use ($signal): void {
            $signal(SIGTERM);
            Loop::addTimer(KILL_GRACE_S, static fn () => $signal(SIGKILL));
        };
        if (!$this->graceful || (!$this->suite && $this->cest === null)) {
            $kill();
            return;
        }
        if ($this->suite) writeHold('stop-suite', '');
        if ($this->cest !== null) writeHold('stop-test', $this->cest);
        $this->say('--- the run is being stopped, and its <after> hooks left to run');
        $budget = ($this->suite ? 2 : 1) * HOOK_BUDGET_S;
        Loop::addTimer($budget, function () use ($budget, $kill): void {
            if ($this->ended) return;
            $this->say("--- the <after> hooks had not finished {$budget}s after the stop, and the run was killed with them still going");
            $kill();
        });
    }
}

$run = new Run();
// One request per connection: a reused connection into the container is
// closed under the next request.
$answer = static fn (int $status, $body = '', array $headers = []) => new Response($status, ['Connection' => 'close', ...$headers], $body);

$handle = static function (ServerRequestInterface $request) use ($run, $answer): Response {
    $method = $request->getMethod();
    $path = $request->getUri()->getPath();

    if ($method === 'PUT' && $path === '/bundle') {
        $tar = proc_open(['tar', 'xzf', '-', '-C', '/'], [['pipe', 'r'], ['file', '/dev/null', 'w'], ['file', '/tmp/unpack.err', 'w']], $pipes);
        try {
            fwrite($pipes[0], (string) $request->getBody());
        } catch (ErrorException) {
            // tar left before the end of what it was sent, and its exit code says whether that matters.
        }
        fclose($pipes[0]);
        $code = proc_close($tar);
        return $code === 0 ? $answer(204) : $answer(500, "tar exited with $code: " . file_get_contents('/tmp/unpack.err'));
    }
    if ($method === 'POST' && $path === '/start') {
        // A container holds one run: a second start would write over the first.
        if ($run->started()) return $answer(409, 'A run was already started here');
        $run->start((string) $request->getBody());
        return $answer(201);
    }
    if ($method === 'POST' && $path === '/stop') {
        $run->stop();
        return $answer(204);
    }
    if ($path === '/events') {
        $follower = new ThroughStream();
        $from = (int) ($request->getQueryParams()['from'] ?? 0);
        // Once the response has taken the stream, so nothing written is lost.
        Loop::futureTick(static fn () => $run->follow($from, $follower));
        return $answer(200, $follower, ['Content-Type' => 'application/x-ndjson']);
    }
    if ($path === '/results') {
        $tar = new Process('exec tar czf - -C /out .');
        $tar->start();
        return $answer(200, $tar->stdout, ['Content-Type' => 'application/gzip']);
    }
    return $answer(200, 'ok');
};

$server = new HttpServer(
    new StreamingRequestMiddleware(),
    new LimitConcurrentRequestsMiddleware(100),
    new RequestBodyBufferMiddleware(256 * 1024 * 1024),
    $handle,
);
$server->listen(new SocketServer('0.0.0.0:8080'));
