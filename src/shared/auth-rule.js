// 鉴权请求头注入。
//
// MOSS-Live 只接受在 WebSocket 握手时通过 Authorization 请求头传 API Key，
// 而浏览器原生 WebSocket 无法设置请求头。这里用 declarativeNetRequest 的会话规则，
// 在握手请求上加上 `Authorization: Bearer <用户自己的 Key>`，因此不需要任何中转服务器。
//
// 另外，MOSS 服务器会拒绝任何带 Origin 头的握手（实测返回 403），
// 而浏览器发起的 WebSocket 一定带 Origin，所以同一条规则里把 Origin 去掉。
//
// 注意：offscreen 文档里没有 declarativeNetRequest，所以这些函数实际运行在 background。
// 规则只对“由本插件自己发起”的 WebSocket 请求生效（initiatorDomains = 本插件 ID）。

const AUTH_RULE_ID = 7001;

export function installAuthRule({ apiKey, realtimeUrl }) {
  const url = new URL(realtimeUrl);
  const rule = {
    id: AUTH_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Authorization', operation: 'set', value: `Bearer ${apiKey}` },
        { header: 'Origin', operation: 'remove' },
      ],
    },
    condition: {
      requestDomains: [url.hostname],
      urlFilter: url.pathname,
      resourceTypes: ['websocket'],
      initiatorDomains: [chrome.runtime.id],
    },
  };
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [AUTH_RULE_ID],
    addRules: [rule],
  });
}

export function removeAuthRule() {
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [AUTH_RULE_ID] });
}
