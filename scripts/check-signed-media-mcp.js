const checkPackagedMediaMcp = require('./check-packaged-media-mcp');

module.exports = async function checkSignedMediaMcp(context) {
  if (context.electronPlatformName === 'darwin') {
    await checkPackagedMediaMcp(context, { signed: true });
  }
};
