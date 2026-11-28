/** CI 只做 schema/check + 同一纯编译器 byte compare，不需要本机 trace。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadStaticCase } from '../src/cases/snapshot.js';
import { renderIR } from '../src/render/render.js';

const root = process.argv[2];
const cases = path.join(root, 'test/e2e/cases');
const files = fs.readdirSync(cases).filter(file => file.endsWith('.ir.json'));
if (!files.length) console.log('ℹ️ 未验证/无正式case：空集合不构成 guard 有效证据');
let failed = false;
for (const file of files) {
  try {
    const snapshot = loadStaticCase(path.join(cases, file));
    if (!('ir' in snapshot)) throw new Error(snapshot.load_error.message);
    if (file !== `${snapshot.ir.name}.ir.json`) throw new Error('IR 文件名与 name 不一致');
    const expected = path.join(root, 'test/e2e/__tests__', `${snapshot.ir.name}.test.ts`);
    if (!fs.existsSync(expected)) throw new Error('缺正式配套 test');
    if (!fs.readFileSync(expected).equals(Buffer.from(renderIR(snapshot.ir)))) throw new Error('编译产物字节不一致');
    console.log(`✅ ${file}: render-check 通过`);
  } catch (error) {
    failed = true;
    console.error(`❌ ${file}: ${(error as Error).message}`);
  }
}
process.exitCode = failed ? 1 : 0;
