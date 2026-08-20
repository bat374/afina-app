package expo.modules.smsreader

import android.Manifest
import android.provider.Telephony
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SmsReaderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoSmsReader")

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.READ_SMS)
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.READ_SMS)
    }

    // Reads Android's own SMS inbox content provider directly on demand -- no background
    // listener/service. A listener needs a foreground-service notification on Android 8+ and
    // still gets killed by OEM battery managers; this feature's UX already requires opening the
    // app to review and confirm a draft, so a scan on launch/resume costs nothing extra.
    AsyncFunction("readInboxAsync") { sinceEpochMs: Double, senders: List<String> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val normalizedSenders = senders.map { it.trim().lowercase() }.toSet()
      val results = mutableListOf<Map<String, Any?>>()
      val projection = arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE)
      context.contentResolver.query(
        Telephony.Sms.Inbox.CONTENT_URI,
        projection,
        "${Telephony.Sms.DATE} >= ?",
        arrayOf(sinceEpochMs.toLong().toString()),
        "${Telephony.Sms.DATE} ASC",
      )?.use { cursor ->
        val idIndex = cursor.getColumnIndexOrThrow(Telephony.Sms._ID)
        val addressIndex = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
        val bodyIndex = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
        val dateIndex = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
        while (cursor.moveToNext()) {
          val address = cursor.getString(addressIndex) ?: continue
          // Empty `senders` means "no filter" (used by the paste-harness's own tooling only);
          // the real scan path always passes the known parser sender list, so an SMS from a bank
          // Afina has no parser for is never even pulled into JS, let alone mis-parsed there.
          if (normalizedSenders.isNotEmpty() && address.trim().lowercase() !in normalizedSenders) continue
          results.add(
            mapOf(
              "id" to cursor.getString(idIndex),
              "address" to address,
              "body" to (cursor.getString(bodyIndex) ?: ""),
              "dateMs" to cursor.getLong(dateIndex).toDouble(),
            )
          )
        }
      }
      results
    }
  }
}
