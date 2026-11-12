/**
 * src/billing/appleRootCert.ts
 *
 * Apple's published Root CA - G3 certificate, pinned so App Store Server JWS
 * chain verification (StoreKit 2 `signedTransaction`, App Store Server
 * Notifications V2 `signedPayload`) never needs a network call. Apple's
 * signing chain for both is: leaf -> Apple Worldwide Developer Relations CA
 * (intermediate, supplied in the JWS `x5c` header) -> this root.
 *
 * Fetched 2026-08-09 directly from
 * https://www.apple.com/certificateauthority/AppleRootCA-G3.cer (Apple's own
 * published download for third-party verifiers) and verified byte-for-byte
 * against that download before being embedded here.
 *
 *   Subject/Issuer: CN=Apple Root CA - G3, OU=Apple Certification Authority,
 *                   O=Apple Inc., C=US (self-signed)
 *   Public key:     EC P-384
 *   Validity:       2014-04-30 -> 2039-04-30
 *   SHA-256 fingerprint:
 *     63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:
 *     7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
 *
 * Public trust-anchor material — not a secret. Rotate only if Apple
 * republishes this root (they have not since its 2014 issuance).
 */

export const APPLE_ROOT_CA_G3_DER_B64 =
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS' +
  'QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u' +
  'IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN' +
  'MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS' +
  'b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y' +
  'aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49' +
  'AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf' +
  'TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517' +
  'IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr' +
  'MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA' +
  'MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4' +
  'at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM' +
  '6BgD56KyKA==';
