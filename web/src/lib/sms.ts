// Sending the login code. No SMS provider is connected yet.
// In development the code is printed to the server log and returned so the login screen can show it.
// In production, sending without a configured provider fails loudly instead of silently skipping.

export type SmsResult = { delivered: boolean; devCode?: string };

export async function sendLoginCode(mobile: string, code: string): Promise<SmsResult> {
  const provider = process.env.SMS_PROVIDER;
  if (!provider) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMS_PROVIDER is not configured; login codes cannot be sent");
    }
    console.log(`[dev] login code for ${mobile}: ${code}`);
    return { delivered: false, devCode: code };
  }
  throw new Error(`SMS provider "${provider}" is not implemented yet`);
}
