/* 一键把游戏工厂上传到 GitHub
   用法：双击「一键上传到GitHub.bat」（先在 推送配置.txt 里填用户名和 Token）
   会：生成版本清单 → 初始化仓库 → 提交 → 推送到 GitHub */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = __dirname;
const CFG = path.join(ROOT, '推送配置.txt');

function readCfg() {
  const o = {};
  if (!fs.existsSync(CFG)) return o;
  fs.readFileSync(CFG, 'utf8').split(/\r?\n/).forEach(function (l) {
    const s = l.trim();
    if (!s || s.charAt(0) === '#' || s.indexOf('=') < 0) return;
    const i = s.indexOf('=');
    o[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return o;
}
function run(cmd, allowFail) {
  try {
    const out = cp.execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out || '' };
  } catch (e) {
    if (!allowFail) throw e;
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}
function step(name) { console.log('\n>>> ' + name); }

(async function () {
  console.log('==============================');
  console.log('   上传到 ' + (isGitee ? 'Gitee' : 'GitHub'));
  console.log('==============================');
  const cfg = readCfg();
  const platform = (cfg['平台'] || 'github').toLowerCase();          /* github / gitee */
  const isGitee = (platform === 'gitee');
  const user = (cfg['用户名'] || '').trim();
  const repo = (cfg['仓库名'] || (isGitee ? 'game-save-sync' : 'game-factory')).trim();
  const branch = (cfg['分支'] || (isGitee ? 'master' : 'main')).trim();
  const token = (cfg['Token'] || '').trim();
  const email = (cfg['邮箱'] || '').trim() || (user + '@users.noreply.github.com');

  if (!user || !token) {
    console.log('还没配置。请用记事本打开「推送配置.txt」，填好这几行：');
    console.log('  平台=gitee 或 github');
    console.log('  用户名=你的账号名');
    console.log('  仓库名=仓库路径（Gitee 通常是 game-save-sync）');
    console.log('  Token=私人令牌');
    console.log('');
    return;
  }

  /* 1) 先生成版本清单 */
  step('生成版本清单');
  run('"' + process.execPath + '" _打包上传.js');

  /* 2) 初始化仓库（首次） */
  step('准备仓库');
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    run('git init');
    run('git branch -M ' + branch);
    console.log('  已初始化本地仓库');
  } else {
    console.log('  仓库已存在');
  }
  run('git config user.name "' + user + '"');
  run('git config user.email "' + email + '"');

  /* 3) 暂存并提交 */
  step('提交改动');
  run('git add -A');
  const st = run('git status --porcelain', true);
  if (!st.out.trim()) {
    console.log('  没有新的改动，跳过提交');
  } else {
    const msg = 'update ' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    run('git commit -m "' + msg + '"');
    console.log('  已提交：' + msg);
  }

  /* 4) 设置远端并推送 */
  step('推送到 GitHub');
  const host = isGitee ? 'gitee.com' : 'github.com';
  const remote = 'https://' + user + ':' + token + '@' + host + '/' + user + '/' + repo + '.git';
  run('git remote remove origin', true);
  run('git remote add origin "' + remote + '"');
  const push = run('git push -u origin ' + branch + ' --force', true);
  if (push.ok) {
    console.log('  ✅ 推送成功！');
    console.log('');
    console.log('仓库地址：https://' + host + '/' + user + '/' + repo);
    console.log('');
    console.log('现在把这一行填进「更新地址.txt」：');
    if (isGitee) {
      console.log('  https://' + host + '/' + user + '/' + repo + '/raw/' + branch + '/');
    } else {
      console.log('  https://raw.githubusercontent.com/' + user + '/' + repo + '/' + branch + '/');
    }
  } else {
    console.log('  ❌ 推送失败：');
    console.log('  ' + push.out.split('\n').slice(-6).join('\n  '));
    console.log('');
    console.log('常见原因：');
    console.log('  · Token 没勾 repo 权限（重新生成时勾上 repo）');
    console.log('  · 仓库不存在（先去 GitHub 建一个空仓库，不要勾 README）');
    console.log('  · 用户名或仓库名拼错');
  }
})();
