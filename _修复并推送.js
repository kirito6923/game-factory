/* 一次性修好：建 game-factory 仓库 → 改配置 → 推送 → 写更新地址 */
const fs = require('fs'), path = require('path'), https = require('https'), cp = require('child_process');
const ROOT = __dirname;

function readCfg() {
  const o = {};
  fs.readFileSync(path.join(ROOT, '推送配置.txt'), 'utf8').split(/\r?\n/).forEach(function (l) {
    const s = l.trim();
    if (!s || s.charAt(0) === '#' || s.indexOf('=') < 0) return;
    const i = s.indexOf('=');
    o[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return o;
}
function api(method, url, token, body) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'User-Agent': 'game-factory', 'Accept': 'application/vnd.github+json', 'Authorization': 'token ' + token };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request(url, { method: method, headers: headers, timeout: 25000 }, function (res) {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', function () {
        let j = null;
        const t = Buffer.concat(c).toString('utf8');
        try { j = JSON.parse(t); } catch (e) {}
        resolve({ status: res.statusCode, json: j, text: t });
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async function () {
  const cfg = readCfg();
  const token = cfg['Token'];
  const user = cfg['用户名'];
  const REPO = 'game-factory';
  const BRANCH = 'main';
  if (!token || !user) { console.log('推送配置.txt 不完整'); return; }

  console.log('=== 1. 检查 / 创建仓库 ' + user + '/' + REPO + ' ===');
  let r = await api('GET', 'https://api.github.com/repos/' + user + '/' + REPO, token);
  if (r.status === 200) {
    console.log('  仓库已存在，直接用');
  } else {
    console.log('  不存在，正在创建…');
    r = await api('POST', 'https://api.github.com/user/repos', token, {
      name: REPO, private: false, auto_init: false,
      description: 'AI 游戏工厂 - 课堂离线小游戏生成器'
    });
    if (r.status === 201) console.log('  ✅ 创建成功：https://github.com/' + user + '/' + REPO);
    else { console.log('  ❌ 创建失败 HTTP ' + r.status + ' ' + (r.json && r.json.message || '')); rl_end(); return; }
  }

  console.log('');
  console.log('=== 2. 更新配置 ===');
  const cfgText = [
    '# 由自动修复脚本生成，别传到 GitHub（含 Token）',
    '用户名=' + user,
    '仓库名=' + REPO,
    '分支=' + BRANCH,
    '邮箱=' + user + '@users.noreply.github.com',
    'Token=' + token
  ].join('\r\n');
  fs.writeFileSync(path.join(ROOT, '推送配置.txt'), cfgText, 'utf8');
  const raw = 'https://raw.githubusercontent.com/' + user + '/' + REPO + '/' + BRANCH + '/';
  fs.writeFileSync(path.join(ROOT, '更新地址.txt'),
    ['# 自动生成：教室电脑从这里拉更新', '', raw, 'https://gh-proxy.com/' + raw].join('\r\n'), 'utf8');
  console.log('  仓库名 → ' + REPO);
  console.log('  更新地址 → ' + raw);

  console.log('');
  console.log('=== 3. 打包并推送 ===');
  try {
    const out = cp.execSync('"' + process.execPath + '" _推送到GitHub.js', { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    console.log(out.split('\n').slice(-14).join('\n'));
  } catch (e) {
    console.log((e.stdout || '') + (e.stderr || ''));
  }
  function rl_end() {}
})();
