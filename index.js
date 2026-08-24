'use strict';

const { OndiloIcoPlatform, PLATFORM_NAME } = require('./platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, OndiloIcoPlatform);
};
