<?php
/* 词块 · 档案进度
 *
 * 三个档案，各存一个文件：
 *   progress/guest.json  游客（不需要密码）
 *   progress/boy.json    男生（需要密码）
 *   progress/girl.json   女生（需要密码）
 *
 * 密码默认 12345（界面上不提示），存在 progress/pass.config.php（PHP 文件，
 * 直接访问不会输出内容，也不会像 .json 那样被当静态文件下载）。改密码走下面
 * ?p=pass&act=set 接口。忘了密码就删掉这个文件 → 回到默认 12345。
 *
 * 接口（只给同目录的页面用）：
 *   GET    progress.php?p=guest          读：{"ts":…,"data":{…}}，没文件返回 {"ts":0,"data":null}
 *   POST   progress.php?p=guest   JSON   写：整体覆盖
 *   DELETE progress.php?p=guest          删：等于清空该档案
 *   boy/girl 这三个接口都要带请求头 X-Profile-Pass: <密码>，否则 401
 *   POST   progress.php?p=pass&act=check {"profile":"boy","pass":"…"}              校验密码
 *   POST   progress.php?p=pass&act=set   {"profile":"boy","pass":"…","new":"…"}    改密码
 *
 * 没有 PHP 环境时，页面会自动退回浏览器本地存储，不会报错。
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

$PROFILES = array('guest', 'boy', 'girl');
$LOCKED   = array('boy', 'girl');

$dir      = __DIR__ . '/progress';
$passFile = $dir . '/pass.config.php';

if (!is_dir($dir)) {
    @mkdir($dir, 0775, true);
    @chmod($dir, 0775);
}

/* ---------------- 密码存取 ---------------- */
/* 密码文件长这样： <?php exit; ?>{"boy":"12345","girl":"12345"}
   前面那截 PHP 头保证直接访问时立即退出、什么都不输出；
   读取时用字符串解析而不是 include —— include 会被 opcache 缓存，
   改完密码马上再改会读到旧值。 */
function load_pass(string $file): array
{
    if (!is_file($file)) {
        return array();
    }
    $raw = (string) @file_get_contents($file);
    $pos = strpos($raw, '?>');
    if ($pos === false) {
        return array();
    }
    $j = json_decode(substr($raw, $pos + 2), true);
    return is_array($j) ? $j : array();
}

function save_pass(string $file, array $a): bool
{
    $php = "<?php exit; ?>" . json_encode($a, JSON_UNESCAPED_UNICODE) . "\n";
    $tmp = $file . '.tmp';
    if (@file_put_contents($tmp, $php, LOCK_EX) === false) {
        return false;
    }
    @chmod($tmp, 0600);
    return @rename($tmp, $file);
}

function get_pass(string $file, string $p): string
{
    $a = load_pass($file);
    return isset($a[$p]) ? (string) $a[$p] : '12345';
}


/* DSM 的 nginx 会把 PHP 的 4xx/5xx 响应替换成它自己的 HTML 错误页，
   前端就拿不到 JSON 了。所以所有错误都用 200 + {"error":"…"} 返回。 */
function fail(string $msg): void
{
    echo json_encode(array('error' => $msg), JSON_UNESCAPED_UNICODE);
    exit;
}

$who    = isset($_GET['p']) ? (string) $_GET['p'] : '';
$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';

/* ---------------- 密码接口 ---------------- */
if ($who === 'pass') {
    if ($method !== 'POST') {
        fail('method not allowed');
    }
    $J = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($J)) {
        fail('bad json');
    }
    $p    = isset($J['profile']) ? (string) $J['profile'] : '';
    $pass = isset($J['pass']) ? (string) $J['pass'] : '';
    if (!in_array($p, $LOCKED, true)) {
        fail('bad profile');
    }
    if (!hash_equals(get_pass($passFile, $p), $pass)) {
        fail('bad-pass');
    }

    $act = isset($_GET['act']) ? (string) $_GET['act'] : '';
    if ($act === 'check') {
        echo '{"ok":true}';
        exit;
    }
    if ($act === 'set') {
        $new = trim(isset($J['new']) ? (string) $J['new'] : '');
        if (strlen($new) < 4) {
            fail('新密码至少 4 位');
        }
        if (strlen($new) > 32) {
            fail('新密码最长 32 位');
        }
        $a = load_pass($passFile);
        $a[$p] = $new;
        if (!save_pass($passFile, $a)) {
            fail('密码保存失败，检查 progress 目录权限');
        }
        echo '{"ok":true}';
        exit;
    }
    fail('bad action');
}

/* ---------------- 进度接口 ---------------- */
if (!in_array($who, $PROFILES, true)) {
    fail('bad profile');
}

if (in_array($who, $LOCKED, true)) {
    $sent = isset($_SERVER['HTTP_X_PROFILE_PASS']) ? (string) $_SERVER['HTTP_X_PROFILE_PASS'] : '';
    if ($sent === '') {
        fail('need-pass');
    }
    if (!hash_equals(get_pass($passFile, $who), $sent)) {
        fail('bad-pass');
    }
}

$file = $dir . '/' . $who . '.json';

/* 读 */
if ($method === 'GET') {
    if (!is_file($file)) {
        echo '{"ts":0,"data":null}';
        exit;
    }
    $j = json_decode((string) @file_get_contents($file), true);
    if (!is_array($j) || !isset($j['data']) || !is_array($j['data'])) {
        echo '{"ts":0,"data":null}';
        exit;
    }
    echo json_encode(
        array('ts' => isset($j['ts']) ? (int) $j['ts'] : 0, 'data' => $j['data']),
        JSON_UNESCAPED_UNICODE
    );
    exit;
}

/* 写 */
if ($method === 'POST') {
    $raw = (string) file_get_contents('php://input');
    if (strlen($raw) > 1048576) {
        fail('too large');
    }
    $j = json_decode($raw, true);
    if (!is_array($j) || !isset($j['data']) || !is_array($j['data'])) {
        fail('bad json');
    }
    if (!is_dir($dir) || !is_writable($dir)) {
        fail('progress 目录不可写');
    }
    $out = json_encode(
        array('v' => 1, 'ts' => time(), 'data' => $j['data']),
        JSON_UNESCAPED_UNICODE
    );
    $tmp = $file . '.tmp';
    if (@file_put_contents($tmp, $out, LOCK_EX) === false || !@rename($tmp, $file)) {
        @unlink($tmp);
        fail('写入失败');
    }
    @chmod($file, 0664);
    echo json_encode(array('ok' => true, 'ts' => time()));
    exit;
}

/* 删 */
if ($method === 'DELETE') {
    if (is_file($file) && !@unlink($file)) {
        fail('删除失败');
    }
    echo '{"ok":true}';
    exit;
}

fail('method not allowed');
