/* 打包上传工具：生成「版本.json」（记录版本号 + 要同步的文件清单）
   用法：node.exe _打包上传.js
   生成后把整个文件夹传到 GitHub，教室电脑运行「更新游戏工厂.bat」即可自动同步 */
const fs = require('fs'), path = require('path');
const ROOT = __dirname;

/* 需要同步到教室电脑的文件（白名单，不含个人配置） */
const include = [
  'game-factory-student-lite.html',
  'game-factory-teacher.html',
  'check.html',
  'fc-original.html',
  'nes.js',
  'builtin-pacman.html',
  '冒险岛4-攻略.html',
  'deepseek-proxy.js',
  '自动更新.js',
  '更新游戏工厂.bat',
  '启动-学生版.bat',
  '启动-教师版.bat',
  '一键关闭.bat'
];

/* 示例文件夹里的所有游戏 */
const sampleDir = path.join(ROOT, '示例');
if (fs.existsSync(sampleDir)) {
  fs.readdirSync(sampleDir).forEach(function (f) {
    if (/\.html$/i.test(f)) include.push('示例/' + f);
  });
}

/* 检查文件是否都存在 */
const missing = include.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.log('警告：这些文件不存在，已跳过——');
  missing.forEach(f => console.log('  ' + f));
}
const files = include.filter(f => fs.existsSync(path.join(ROOT, f)));

/* 版本号：用当前时间，保证每次打包都不一样 */
const d = new Date();
const pad = n => String(n).padStart(2, '0');
const version = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
  '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());

const manifest = { version: version, files: files };
fs.writeFileSync(path.join(ROOT, '版本.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log('已生成 版本.json');
console.log('  版本号：' + version);
console.log('  文件数：' + files.length);
files.forEach(f => {
  const sz = fs.statSync(path.join(ROOT, f)).size;
  console.log('    ' + f + '  (' + Math.round(sz / 1024) + ' KB)');
});
console.log('');
console.log('下一步：');
console.log('  1. 把这个文件夹里的文件（含 版本.json）上传到 GitHub 仓库');
console.log('  2. 在「更新地址.txt」里填上 raw 地址（见该文件说明）');
console.log('  3. 教室电脑双击「更新游戏工厂.bat」就会自动同步');
console.log('');
console.log('注意：接口设置.txt / 使用说明.txt / 光驱设置 等个人配置不会被同步，');
console.log('      教室电脑上你自己的这几项不会被覆盖。');
