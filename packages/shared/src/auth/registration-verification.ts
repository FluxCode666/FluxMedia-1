import { requestGoBackendJson } from "../http/go-backend";

export async function sendRegistrationVerificationCode(email: string) {
  return requestGoBackendJson<{ simulated: boolean }>("/api/auth/registration-verification", {
    method: "POST", body: JSON.stringify({ email }),
  });
}

export async function verifyRegistrationCode(email: string, code: string) {
  const result = await requestGoBackendJson<{ valid: boolean }>("/api/auth/registration-verification/verify", {
    method: "POST", body: JSON.stringify({ email, code }),
  });
  return result.valid;
}
