/* 游戏工厂自动更新器：从 GitHub / 网盘直链拉取最新文件
   用法：双击「更新游戏工厂.bat」
   配置：更新地址.txt 里填一行或多行地址（见该文件的说明） */
const https = require('https'), http = require('http');
const fs = require('fs'), path = require('path');

const ROOT = __dirname;
const CFG = path.join(ROOT, '更新地址.txt');
const VERF = path.join(ROOT, '版本.txt');
const BAKDIR = path.join(ROOT, '备份');

/* 这些文件永远不覆盖（老师的个人配置 / 已在用的更新地址） */
const PROTECT = ['接口设置.txt', '更新地址.txt', '版本.txt', '使用说明.txt'];

function readBases() {
  if (!fs.existsSync(CFG)) return [];
  return fs.readFileSync(CFG, 'utf8').split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && s.indexOf('http') === 0 && s.indexOf('#') !== 0)
    .map(s => s.replace(/\/+$/, '') + '/');
}

function httpGet(url, timeout) {
  return new Promise((resolve, reject) => {
    const mod = url.indexOf('https') === 0 ? https : http;
    const req = mod.get(url, { timeout: timeout || 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(res.headers.location, timeout).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

function encPath(rel) {
  return rel.split('/').map(s => encodeURIComponent(s)).join('/');
}

async function fetchFromBases(bases, rel) {
  let lastErr = null;
  for (const base of bases) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await httpGet(base + encPath(rel) + '?t=' + Date.now());
      } catch (e) {
        lastErr = e;
        if (attempt < 3) console.log('      重试 ' + attempt + '/3（' + e.message + '）');
      }
    }
    console.log('   这个地址失败，换下一个…');
  }
  throw lastErr || new Error('所有地址都失败');
}

(async function () {
  console.log('==============================');
  console.log('   AI 游戏工厂 · 自动更新');
  console.log('==============================');
  const bases = readBases();
  if (!bases.length) {
    console.log('');
    console.log('还没配置更新地址。');
    console.log('请用记事本打开「更新地址.txt」，按里面的说明填一行地址再运行。');
    console.log('');
    return;
  }
  console.log('更新源：' + bases[0]);
  console.log('');

  /* 1) 取远端版本清单 */
  let manifest;
  try {
    const buf = await fetchFromBases(bases, 'version.json');
    manifest = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    console.log('拿不到版本清单（' + e.message + '）');
    console.log('可能是没联网，或地址填错了。不影响上课，继续用本地版本。');
    return;
  }
  const remoteVer = String(manifest.version || '');
  const localVer = fs.existsSync(VERF) ? fs.readFileSync(VERF, 'utf8').trim() : '';
  console.log('本地版本：' + (localVer || '（未知）'));
  console.log('最新版本：' + remoteVer);
  if (remoteVer && remoteVer === localVer) {
    console.log('');
    console.log('已经是最新的，不需要更新。');
    return;
  }

  /* 2) 备份现有文件 */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = path.join(BAKDIR, stamp);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  let okCount = 0, failCount = 0;
  console.log('');
  console.log('需要更新 ' + files.length + ' 个文件…');
  console.log('');

  for (const rel of files) {
    if (PROTECT.indexOf(rel) >= 0) { console.log('  跳过（保护）：' + rel); continue; }
    const dst = path.join(ROOT, rel);
    try {
      const data = await fetchFromBases(bases, rel);
      if (!data || data.length === 0) throw new Error('下载到空文件');
      /* 备份旧文件 */
      if (fs.existsSync(dst)) {
        const b = path.join(bak, rel);
        const bd = path.dirname(b);
        if (!fs.existsSync(bd)) fs.mkdirSync(bd, { recursive: true });
        fs.copyFileSync(dst, b);
      } else {
        const dd = path.dirname(dst);
        if (!fs.existsSync(dd)) fs.mkdirSync(dd, { recursive: true });
      }
      fs.writeFileSync(dst, data);
      okCount++;
      console.log('  ✅ ' + rel + '（' + Math.round(data.length / 1024) + ' KB）');
    } catch (e) {
      failCount++;
      console.log('  ❌ ' + rel + '：' + e.message);
    }
  }

  console.log('');
  if (failCount === 0) {
    fs.writeFileSync(VERF, remoteVer, 'utf8');
    console.log('更新完成：' + okCount + ' 个文件已更新到版本 ' + remoteVer);
    console.log('旧文件备份在：备份\\' + stamp);
    console.log('');
    console.log('请关闭浏览器页面，重新双击「启动-学生版.bat」即可看到新版。');
  } else {
    console.log('部分文件失败（' + failCount + ' 个），为安全起见没有更新版本号。');
    console.log('可以再运行一次，或检查网络后重试。旧文件在：备份\\' + stamp);
  }
})();

