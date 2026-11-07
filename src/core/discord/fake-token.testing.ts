/** The made-up tokens tests use, put together at run time so no token-shaped text sits in the source. */
const PARTS = {
  a: ["MTAxMjM0NTY3ODkwMTIzNDU2", "fakeaa", "fake_token_for_tests_only_aa"],
  b: ["MTAxMjM0NTY3ODkwMTIzNDU2", "fakebb", "fake_token_for_tests_only_bb"],
  file: ["MTAxMjM0NTY3ODkwMTIzNDU2", "file", "fileFileFileFileFileFileFile"],
} as const

/** A made-up user token, shaped like a real one. */
export function fakeToken(variant: keyof typeof PARTS = "a"): string {
  return PARTS[variant].join(".")
}

/** A made-up `mfa.` token. */
export function fakeMfaToken(): string {
  return ["mfa", "fake_mfa_token_for_tests_only"].join(".")
}
