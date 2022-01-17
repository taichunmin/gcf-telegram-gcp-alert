const _ = require('lodash')
const { errToPlainObj, log, middlewareCompose } = require('./helper')
const dayjs = require('./dayjs')
const msgJson5 = require('./msgJson5')
const Telegram = require('./telegram').Client

const EXPRESS_REQ_KEYS = ['baseUrl', 'body', 'hostname', 'ip', 'method', 'originalUrl', 'path', 'protocol', 'query']
const escapeMd2 = str => str.replace(/[_*[()~`>#+=|{}.!\]-]/g, c => `\\${c}`)
const unixToStr = t => t ? dayjs.unix(t).utcOffset(8).format('M/D HH:mm') : null

const msgIncident = incident => ({
  disable_web_page_preview: true,
  parse_mode: 'MarkdownV2',
  text: `${escapeMd2(incident.summary)}\n\n` +
    `發生時間：${escapeMd2(unixToStr(incident.started_at) + ' ~ ' + unixToStr(incident.ended_at))}\n` +
    `異常編號：\`${incident.incident_id}\` \\(次數 ${incident.condition?.conditionThreshold?.trigger?.count}\\)\n` +
    `資源名稱：\`${incident.resource_display_name}\`\n` +
    `政策名稱：\`${incident.policy_name}\`\n` +
    `條件名稱：\`${incident.condition_name}\`\n` +
    `異常狀態：\`${incident.state}\``,
})

const middlewares = middlewareCompose([
  // init telegram
  async (ctx, next) => {
    try {
      const { req } = ctx
      ctx.token = req?.query?.token ?? ''
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(ctx.token)) throw new Error('invalid token')
      ctx.telegram = new Telegram({ token: ctx.token })
      ctx.log = log
      log({ message: '收到 Webhook', ..._.pick(req, EXPRESS_REQ_KEYS) })
      const update = ctx.update = ctx.req?.body // https://core.telegram.org/bots/api#update

      ctx.sendMessage = async args => {
        if (_.isString(args)) args = { text: args }
        const message = update?.message ?? update?.edited_message
        args = {
          chat_id: message?.chat?.id ?? req?.query?.chat_id,
          ...args,
        }
        if (!args.chat_id) return
        await ctx.telegram.sendMessage(args)
      }

      ctx.replyMessage = async args => {
        if (_.isString(args)) args = { text: args }
        const message = update?.message ?? update?.edited_message
        await ctx.sendMessage({
          allow_sending_without_reply: true,
          reply_to_message_id: message?.message_id,
          ...args,
        })
      }

      await next()
    } catch (err) {
      if (ctx.replyMessage) await ctx.replyMessage(msgJson5(_.omit(errToPlainObj(err), ['stack'])))
      // 避免錯誤拋到外層
      err.message = `init: ${err.message}`
      log('ERROR', err)
    }
  },

  // 如果是來自 gcp alert 的 incident
  async (ctx, next) => {
    const incident = ctx?.req?.body?.incident
    if (!incident) return await next()

    // https://gist.github.com/taichunmin/7866984246d0a3711b30bfcf9218e069
    log({ message: `收到來自 GCP 的快訊: 政策「${incident.policy_name}」，條件「${incident.condition_name}」，資源「${incident.resource_name}」，狀態為「${incident.state}」。`, incident })
    await ctx.sendMessage(msgIncident(incident))
  },

  // 如果是來自 Telegram 的 update
  async (ctx, next) => {
    const { update } = ctx
    if (!update.message) return await next()

    // https://gist.github.com/taichunmin/7866984246d0a3711b30bfcf9218e069
    log({ message: `收到來自 Telegram 的 update: ${JSON.stringify(update.from)}`, update })
    await ctx.replyMessage(msgJson5(update))
  },
])

exports.main = async (req, res) => {
  try {
    await middlewares({ req })
    res.status(200).send('OK')
  } catch (err) {
    log('ERROR', err)
    res.status(err.status || 500).send(err.message)
  }
}
