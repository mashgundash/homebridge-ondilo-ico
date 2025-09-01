
'use strict';

const { OndiloIcoPlatform } = require('./platform');

module.exports = (api) => {
  api.registerPlatform('OndiloICO', OndiloIcoPlatform);
};
