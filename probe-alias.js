const { Context } = require('koishi')
const mockP = require('@koishijs/plugin-mock'); const mock = mockP.default ?? mockP

const probe = {
  name: 'alias-probe',
  apply(ctx) {
    ctx.command('aa').alias('x').action(() => 'ROOT')
    ctx.command('aa.bb').alias('y').action(() => 'CHILD-ALIAS')
    ctx.command('aa.cc').action(() => 'CHILD')
    // 冲突测试
    try { ctx.command('aa.dd').alias('x').action(() => 'DUP') ; console.log('冲突别名：没报错') }
    catch (e) { console.log('冲突别名报错：', e.message) }
  },
}

;(async () => {
  const app = new Context()
  app.plugin(mock); app.plugin(probe)
  await app.start()
  const c = app.mock.client('u1', 'r')
  for (const input of ['x', 'x cc', 'y', 'aa bb', 'y 内容']) {
    const out = await c.receive(input)
    console.log(input, '=>', JSON.stringify(out).slice(0, 60))
  }
  await app.stop()
})()
