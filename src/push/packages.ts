// Android package ids for the bank apps whose notifications Afina is allowed to inspect.
// Filtering by this list happens natively, before a notification's title/text are even read —
// not a JS-side afterthought — so a listener that's technically registered system-wide never
// actually looks at anything outside these apps.
//
// NOT VERIFIED against the user's real devices yet: Russian bank APKs are frequently
// sideloaded/RuStore builds, and package ids can differ from the Play Store release. Confirm
// each one (Settings -> Apps -> [bank] -> package name, or `adb shell pm list packages`) before
// wiring the native listener's allowlist to this file.
export const KNOWN_BANK_PACKAGES: Record<string, string> = {
  sberbank: 'ru.sberbankmobile',
  alfabank: 'ru.alfabank.mobile.android',
  tinkoff: 'com.idamob.tinkoff.bank',
  ozon: 'ru.ozon.app.android',
};
