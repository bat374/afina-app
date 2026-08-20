import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type SmsMessage = { id: string; address: string; body: string; dateMs: number };
type PermissionResult = { granted: boolean; canAskAgain: boolean; status: string };

type SmsReaderNativeModule = {
  getPermissionsAsync(): Promise<PermissionResult>;
  requestPermissionsAsync(): Promise<PermissionResult>;
  readInboxAsync(sinceEpochMs: number, senders: string[]): Promise<SmsMessage[]>;
};

// Android only -- there is no equivalent SMS-inbox API on iOS for a third-party app to read.
export const isSmsReaderAvailable = Platform.OS === 'android';

const native = Platform.OS === 'android' ? requireOptionalNativeModule<SmsReaderNativeModule>('ExpoSmsReader') : null;

export async function hasSmsPermission(): Promise<boolean> {
  if (!native) return false;
  return (await native.getPermissionsAsync()).granted;
}

export async function requestSmsPermission(): Promise<boolean> {
  if (!native) return false;
  return (await native.requestPermissionsAsync()).granted;
}

export async function readSmsInbox(sinceEpochMs: number, senders: string[]): Promise<SmsMessage[]> {
  if (!native) return [];
  return native.readInboxAsync(sinceEpochMs, senders);
}
