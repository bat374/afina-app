import TextRecognition from '@react-native-ml-kit/text-recognition';

// Receipt "recognition" for the AI assistant is just on-device OCR text extraction, reusing the
// same package src/ocr.ts already uses for account screenshots -- but unlike ocr.ts, this does
// NOT run the account-shape parser (rate/balance heuristics don't apply to a grocery receipt).
// The extracted text is sent to the assistant as a plain user message; the model then decides
// whether to call propose_operation or propose_bill_split from it. The photo itself never leaves
// the phone -- only this text does, and only through the same channel as anything else typed
// into the chat.
export async function extractReceiptText(uri: string): Promise<string> {
  const result = await TextRecognition.recognize(uri);
  return result.text;
}
