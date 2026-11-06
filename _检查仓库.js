/* 用已保存的 Token 查询 GitHub 账号信息与仓库列表，帮助定位推送失败原因 */
const fs = require('fs'), path = require('path'), https = require('https');
const ROOT = __dirname;

function readCfg() {
  const o = {};
  const p = path.join(ROOT, '推送配置.txt');
  if (!fs.existsSync(p)) return o;
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(function (l) {
    const s = l.trim();
    if (!s || s.charAt(0) === '#' || s.indexOf('=') < 0) return;
    const i = s.indexOf('=');
    o[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return o;
}
function api(url, token) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, {
      headers: { 'User-Agent': 'game-factory-check', 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' },
      timeout: 20000
    }, function (res) {
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
  });
}
(async function () {
  const cfg = readCfg();
  const token = cfg['Token'] || '';
  if (!token) { console.log('推送配置.txt 里没有 Token'); return; }
  console.log('配置里的用户名：' + (cfg['用户名'] || '(空)'));
  console.log('配置里的仓库名：' + (cfg['仓库名'] || '(空)'));
  console.log('');
  try {
    const me = await api('https://api.github.com/user', token);
    if (me.status !== 200) { console.log('Token 无效：HTTP ' + me.status); return; }
    console.log('Token 属于账号：' + me.json.login);
    console.log('');
    const repos = await api('https://api.github.com/user/repos?per_page=100&sort=updated', token);
    if (repos.status !== 200) { console.log('查仓库失败：HTTP ' + repos.status); return; }
    console.log('你账号下的仓库（共 ' + repos.json.length + ' 个）：');
    repos.json.forEach(function (r) {
      console.log('  · ' + r.name + '    (' + (r.private ? '私有' : '公开') + ')  ' + r.html_url);
    });
    const target = (cfg['仓库名'] || '').trim();
    const found = repos.json.filter(r => r.name === target)[0];
    console.log('');
    if (found) {
      console.log('✅ 找到配置里指定的仓库：' + found.name);
      console.log('   raw 地址应为：https://raw.githubusercontent.com/' + me.json.login + '/' + encodeURIComponent(found.name) + '/main/');
    } else {
      console.log('❌ 没找到名为「' + target + '」的仓库。');
      const en = repos.json.filter(r => /^[A-Za-z0-9._-]+$/.test(r.name));
      if (en.length) console.log('   建议把 推送配置.txt 的仓库名改成英文名的那个，比如：' + en[0].name);
    }
  } catch (e) {
    console.log('网络错误：' + e.message);
  }
})();
