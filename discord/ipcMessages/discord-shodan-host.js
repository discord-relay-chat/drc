'use strict';

module.exports = async function (parsed, context) {
  const { sendToBotChan } = context;
  const hostObj = parsed.data;

  if (hostObj.error) {
    sendToBotChan(
      '`HOST LOOKUP` FAILED! **' + hostObj.error.message.replace('got.get : ', '') + '**'
    );
  } else {
    sendToBotChan(
      '`HOST LOOKUP` for ' + `**${hostObj.ip_str}**:\n\n` +
      `**Owner**:\n\t${hostObj.org} (hosted by ${hostObj.isp}) in ${hostObj.city}, ${hostObj.region_code}, ${hostObj.country_code}\n\n` +
      '**Open Services**:\n' + hostObj.data.sort((a, b) => a.port - b.port).map((svc) => (
        `\t**${svc.port} (${svc.transport})** _${svc.product}_`
      )).join('\n')
    );
  }
};
