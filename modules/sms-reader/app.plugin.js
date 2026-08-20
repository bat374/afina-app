const { AndroidConfig, createRunOncePlugin } = require('expo/config-plugins');

// READ_SMS is enough for a foreground on-demand inbox scan (see SmsReaderModule.kt) -- no
// RECEIVE_SMS, since this deliberately does not listen for incoming SMS in the background.
const withSmsReaderPermissions = (config) => AndroidConfig.Permissions.withPermissions(config, ['android.permission.READ_SMS']);

module.exports = createRunOncePlugin(withSmsReaderPermissions, 'sms-reader', '1.0.0');
