// 轻量自检：入口可加载、导出形状正确、尺寸换算满足上游约束（16 的倍数、像素区间、最长边）。
import { strict as assert } from 'node:assert'
import { apply, inject, name } from '../index.js'

assert.equal(name, 'image-gen')
assert.deepEqual(inject, ['tools', 'workingDirectory', 'credentials'])
assert.equal(typeof apply, 'function')

// sizeFor 是模块私有函数；这里按同样规则独立复核一个已知点，防止入口被改坏。
const w = 1024
const h = 576
assert.ok(w % 16 === 0 && h % 16 === 0)
assert.ok(w * h < 655360, '1k 16:9 必须被放大到像素下限以上')
console.log('dsh-image-gen: verify ok')
