import { describe, expect, test } from "bun:test"
import { KeyScan, SECRET_FOLDERS, SECRET_NAME, secretRefusal } from "./secrets"

const NAME_REASON = "it is named like a credential, key or database"
const KEY_HEADER = "-----BEGIN RSA PRIVATE KEY-----"

describe("SECRET_NAME", () => {
  test.each([
    ".env",
    ".env.local",
    ".ENV",
    "server.pem",
    "tls.key",
    "cert.p12",
    "cert.pfx",
    "login.keychain",
    "login.keychain-db",
    "vault.kdbx",
    "app.sqlite",
    "app.sqlite3",
    "data.db",
    "release.jks",
    "release.keystore",
    "mail.gpg",
    "mail.asc",
    "work.ovpn",
    "dev.mobileprovision",
    "id_rsa",
    "id_rsa.pub",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".git-credentials",
    "aws-credentials.txt",
    "my-secret.txt",
    "MySecrets.md",
    "passwords.csv",
    "Password.txt",
    "KEY.PEM",
  ])("matches %s", (name) => {
    expect(SECRET_NAME.test(name)).toBe(true)
  })

  test.each([
    "env.txt",
    "keynote.pdf",
    "database-design.png",
    "id.txt",
    "idea.md",
    "photo.db.png",
    "photo.pem.png",
    "monkey.txt",
    "notes.txt",
    "x.netrc",
    "my.npmrc",
    "README.md",
    "key",
    "pem",
  ])("passes %s", (name) => {
    expect(SECRET_NAME.test(name)).toBe(false)
  })
})

describe("SECRET_FOLDERS", () => {
  test("holds the folders of credentials, in lower case", () => {
    expect([...SECRET_FOLDERS].sort()).toEqual(
      [
        ".aws",
        ".azure",
        ".config",
        ".docker",
        ".git",
        ".gnupg",
        ".kube",
        ".password-store",
        ".ssh",
        "keychains",
      ].sort(),
    )
    for (const folder of SECRET_FOLDERS) expect(folder).toBe(folder.toLowerCase())
  })
})

describe("secretRefusal", () => {
  test("passes a path with nothing secret in it", () => {
    expect(secretRefusal(["home", "me", "work", "notes.txt"])).toBeUndefined()
    expect(secretRefusal(["notes.txt"])).toBeUndefined()
    expect(secretRefusal([])).toBeUndefined()
  })

  test("refuses a file inside a folder that holds credentials, whatever its name", () => {
    expect(secretRefusal(["home", "me", ".ssh", "notes.txt"])).toBe("it is in a .ssh folder, which holds credentials")
    expect(secretRefusal([".git", "HEAD"])).toBe("it is in a .git folder, which holds credentials")
    expect(secretRefusal([".aws", "deep", "nested", "a.txt"])).toBe("it is in a .aws folder, which holds credentials")
  })

  test("matches a folder by its lower-cased name and shows it as written", () => {
    expect(secretRefusal(["home", ".SSH", "a.txt"])).toBe("it is in a .SSH folder, which holds credentials")
    expect(secretRefusal(["Keychains", "a.txt"])).toBe("it is in a Keychains folder, which holds credentials")
  })

  test("passes a folder named like a credential folder without its dot", () => {
    expect(secretRefusal(["config", "a.txt"])).toBeUndefined()
    expect(secretRefusal(["git", "ssh", "a.txt"])).toBeUndefined()
  })

  test("does not judge the file name as a folder", () => {
    expect(secretRefusal(["home", ".ssh"])).toBeUndefined()
    expect(secretRefusal(["home", ".config"])).toBeUndefined()
  })

  test("refuses a name that looks like a credential, key or database", () => {
    expect(secretRefusal(["home", "me", ".env"])).toBe(NAME_REASON)
    expect(secretRefusal(["id_ed25519"])).toBe(NAME_REASON)
  })

  test("checks the folders before the name", () => {
    expect(secretRefusal([".ssh", "id_rsa"])).toBe("it is in a .ssh folder, which holds credentials")
  })

  test("names the first folder that holds credentials", () => {
    expect(secretRefusal(["a\u202eb", ".git", ".ssh", "x"])).toBe("it is in a .git folder, which holds credentials")
  })
})

describe("KeyScan", () => {
  const pieces = (text: string, cut: number) => [Buffer.from(text.slice(0, cut)), Buffer.from(text.slice(cut))]

  function scan(chunks: Uint8Array[]): boolean {
    const keys = new KeyScan()
    return chunks.some((chunk) => keys.push(chunk))
  }

  test("finds a header in one piece", () => {
    expect(scan([Buffer.from(`text\n${KEY_HEADER}\nMIIB\n`)])).toBe(true)
  })

  test.each([
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  ])("finds %s", (header) => {
    expect(scan([Buffer.from(header)])).toBe(true)
  })

  test("finds a header split at every cut point", () => {
    const text = `${"a".repeat(100)}${KEY_HEADER}\nMIIB\n`
    for (let cut = 100; cut <= 100 + KEY_HEADER.length; cut += 1) {
      expect(scan(pieces(text, cut))).toBe(true)
    }
  })

  test("finds a header cut into single bytes", () => {
    expect(scan([...Buffer.from(KEY_HEADER)].map((byte) => Buffer.from([byte])))).toBe(true)
  })

  test("passes a public key, a certificate and plain text", () => {
    expect(scan([Buffer.from("-----BEGIN PUBLIC KEY-----\n-----BEGIN CERTIFICATE-----\nhello")])).toBe(false)
    expect(scan([Buffer.from("-----BEGIN PRIVATE"), Buffer.from(" KEY---")])).toBe(false)
  })

  test("keeps its state per scanner", () => {
    const first = new KeyScan()
    const second = new KeyScan()
    first.push(Buffer.from("-----BEGIN RSA PRIV"))
    expect(second.push(Buffer.from("ATE KEY-----"))).toBe(false)
    expect(first.push(Buffer.from("ATE KEY-----"))).toBe(true)
  })
})
