/* 游戏工厂 · GitHub 一键配置向导
   双击「配置向导.bat」运行。
   会依次完成：填配置 → 验证 Token → 检查/创建仓库 → 上传 → 写好更新地址 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const https = require('https');
const readline = require('readline');

const ROOT = __dirname;
const CFG = path.join(ROOT, '推送配置.txt');
const UPURL = path.join(ROOT, '更新地址.txt');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, a => r(String(a || '').trim())));
const askDefault = async (q, d) => { const a = await ask(q + (d ? '（默认 ' + d + '）' : '') + '：'); return a || d || ''; };

function api(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'User-Agent': 'game-factory-updater',
      'Accept': 'application/vnd.github+json',
      'Authorization': 'token ' + token
    };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request(url, { method: method, headers: headers, timeout: 20000 }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接超时（网络不通？）')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function run(cmd, allowFail) {
  try {
    return { ok: true, out: cp.execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '' };
  } catch (e) {
    if (!allowFail) throw e;
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

(async function () {
  console.log('');
  console.log('==========================================');
  console.log('   游戏工厂 · GitHub 配置向导');
  console.log('==========================================');
  console.log('');
  console.log('需要准备的只有两样：');
  console.log('  1) 你的 GitHub 用户名');
  console.log('  2) 一个 Token（下面会说怎么弄）');
  console.log('');

  /* ---------- 0) 检查 git ---------- */
  const gv = run('git --version', true);
  if (!gv.ok) {
    console.log('❌ 这台电脑没装 git，没法上传。');
    console.log('   去 https://git-scm.com/download/win 下载安装（一路下一步即可），再重新运行。');
    rl.close();
    return;
  }
  console.log('✅ git 已就绪：' + gv.out.trim());
  console.log('');

  /* ---------- 1) 用户名 ---------- */
  let user = '';
  for (let tries = 0; tries < 5 && !user; tries++) {
    user = await askDefault('请输入你的 GitHub 用户名', '');
    if (!user) console.log('  这个不能空着。');
  }
  if (!user) { console.log(''); console.log('没有输入用户名，已退出。'); rl.close(); return; }

  /* ---------- 2) Token ---------- */
  console.log('');
  console.log('----------- 怎么拿 Token -----------');
  console.log('  浏览器打开：https://github.com/settings/tokens');
  console.log('  点 Generate new token (classic)');
  console.log('  Note 随便填（比如 game-factory）');
  console.log('  Expiration 选 No expiration 或 90 days');
  console.log('  勾选最上面的 [repo] 整个大项');
  console.log('  点最下面的 Generate token');
  console.log('  复制那串 ghp_ 开头的字符');
  console.log('------------------------------------');
  console.log('');
  let token = '';
  for (let tries = 0; tries < 5 && !token; tries++) {
    token = await ask('把 Token 粘贴到这里（右键即可粘贴）：');
    if (!token) console.log('  这个不能空着。');
  }
  if (!token) { console.log(''); console.log('没有输入 Token，已退出。'); rl.close(); return; }
  token = token.replace(/^token\s*/i, '').trim();

  /* ---------- 3) 验证 Token ---------- */
  console.log('');
  console.log('正在验证 Token…');
  let me;
  try {
    const r = await api('GET', 'https://api.github.com/user', token);
    if (r.status === 401) {
      console.log('❌ Token 无效（401）。请确认复制完整、没多空格，或重新生成一个。');
      rl.close(); return;
    }
    if (r.status !== 200) {
      console.log('❌ 验证失败：HTTP ' + r.status + ' ' + (r.json && r.json.message || ''));
      rl.close(); return;
    }
    me = r.json;
    console.log('✅ 登录成功，账号：' + me.login);
    if (me.login.toLowerCase() !== user.toLowerCase()) {
      console.log('   注意：Token 属于 ' + me.login + '，和你填的 ' + user + ' 不一致，以 Token 为准。');
      user = me.login;
    }
  } catch (e) {
    console.log('❌ 连不上 GitHub（' + e.message + '）。可能是网络问题，稍后再试。');
    rl.close(); return;
  }

  /* ---------- 4) 仓库名 ---------- */
  console.log('');
  const repo = await askDefault('仓库名', 'game-factory');
  const branch = 'main';

  /* ---------- 5) 检查 / 创建仓库 ---------- */
  console.log('');
  console.log('正在检查仓库 ' + user + '/' + repo + ' …');
  let needCreate = false;
  try {
    const r = await api('GET', 'https://api.github.com/repos/' + user + '/' + repo, token);
    if (r.status === 404) { needCreate = true; console.log('  仓库还不存在，我来创建。'); }
    else if (r.status === 200) { console.log('  仓库已存在，直接使用。'); }
    else { console.log('  查询失败 HTTP ' + r.status); }
  } catch (e) {
    console.log('  查询时网络出错：' + e.message);
  }
  if (needCreate) {
    try {
      const r = await api('POST', 'https://api.github.com/user/repos', token, {
        name: repo, private: false, auto_init: false,
        description: 'AI 游戏工厂（课堂用离线小游戏生成器）'
      });
      if (r.status === 201) console.log('✅ 仓库已创建（Public）');
      else {
        console.log('❌ 创建失败：HTTP ' + r.status + ' ' + (r.json && r.json.message || ''));
        console.log('   请先手动到 GitHub 建一个空仓库 ' + repo + '（Public，不要勾 README）再重来。');
        rl.close(); return;
      }
    } catch (e) {
      console.log('❌ 创建仓库时网络出错：' + e.message);
      rl.close(); return;
    }
  }

  /* ---------- 6) 写入配置文件 ---------- */
  const cfgText = [
    '# 由配置向导自动生成，别把这个文件传到 GitHub（含 Token）',
    '用户名=' + user,
    '仓库名=' + repo,
    '分支=' + branch,
    '邮箱=' + user + '@users.noreply.github.com',
    'Token=' + token
  ].join('\r\n');
  fs.writeFileSync(CFG, cfgText, 'utf8');
  console.log('');
  console.log('✅ 配置已保存到 推送配置.txt');

  /* ---------- 7) 上传 ---------- */
  console.log('');
  const go = await askDefault('现在就把游戏上传到 GitHub 吗？(y/n)', 'y');
  if (go.toLowerCase() === 'y') {
    console.log('');
    console.log('---------- 开始上传 ----------');
    const up = run('node.exe _推送到GitHub.js', true);
    console.log(up.out);
  }

  /* ---------- 8) 写好更新地址 ---------- */
  const rawUrl = 'https://raw.githubusercontent.com/' + user + '/' + repo + '/' + branch + '/';
  const urlText = [
    '# 自动生成：教室电脑从这里拉取更新',
    '# 第一个地址失败会自动换第二个（国内可以加镜像）',
    '',
    rawUrl,
    'https://gh-proxy.com/' + rawUrl
  ].join('\r\n');
  fs.writeFileSync(UPURL, urlText, 'utf8');
  console.log('');
  console.log('✅ 更新地址已写入 更新地址.txt：');
  console.log('   ' + rawUrl);
  console.log('');
  console.log('==========================================');
  console.log('   配置完成！');
  console.log('==========================================');
  console.log('');
  console.log('接下来：');
  console.log('  · 这台"母机"：以后改完游戏，双击「一键上传到GitHub.bat」');
  console.log('  · 教室电脑：双击「更新游戏工厂.bat」自动同步');
  console.log('  · 教室电脑不需要 推送配置.txt（里面有 Token，别复制过去）');
  console.log('');
  rl.close();
})();

