import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { idTime } from "../chats/format"
import { ALICE, BOB, CHANNEL, DM, msgId, OTHER_CHANNEL, SERVER, userObject } from "../discord/objects.testing"
import { said, seedWorld, store, THREAD } from "../search/search.testing"
import {
  chatIds,
  createInboxFixture,
  GROUP,
  type InboxFixture,
  mentioning,
  mine,
  replying,
  seedGroup,
} from "./inbox.testing"

let f: InboxFixture
beforeEach(async () => {
  f = await createInboxFixture()
  seedWorld(f)
  seedGroup(f)
})
afterEach(async () => {
  await f.dispose()
})

const waiting = (args: Record<string, unknown> = {}) => f.inbox({ method: "waiting", ...args })

describe("a DM or a group DM", () => {
  test("waits for every message from the other side, and says so", async () => {
    store(f, said(DM, 1), said(DM, 2))
    const result = await waiting()
    expect(result).toMatchObject({ method: "waiting", source: "mirror", total: 1, more: false })
    expect(result.chats).toEqual([
      {
        chat: { id: DM, name: "user02", kind: "dm", server: null, server_name: null },
        why: ["dm"],
        waiting: 2,
        since: idTime(msgId(1)),
        latest: { id: msgId(2), at: idTime(msgId(2)), author_id: ALICE, author: "user02", text: "text 002" },
        current: false,
      },
    ])
  })

  test("a group DM is named as people see it", async () => {
    store(f, said(GROUP, 1, { author: userObject(BOB) }))
    expect((await waiting()).chats).toMatchObject([
      { chat: { id: GROUP, name: "Team", kind: "group_dm" }, why: ["dm"], waiting: 1 },
    ])
  })

  test("counts only what came after the user's last message there", async () => {
    store(f, said(DM, 1), mine(DM, 2), said(DM, 3), said(DM, 4))
    const [chat] = (await waiting()).chats!
    expect(chat).toMatchObject({ waiting: 2, since: idTime(msgId(3)), latest: { id: msgId(4) } })
  })

  test("is answered when the user wrote last", async () => {
    store(f, said(DM, 1), mine(DM, 2))
    expect((await waiting()).chats).toEqual([])
  })

  test("never waits for the user's own messages", async () => {
    store(f, mine(DM, 1))
    expect((await waiting()).chats).toEqual([])
  })

  test("another chat's answer does not count", async () => {
    store(f, said(DM, 1), mine(GROUP, 2))
    expect(chatIds(await waiting())).toEqual([DM])
  })

  test("only ordinary messages and replies count, not system messages", async () => {
    store(f, said(DM, 1, { type: 7 }), said(DM, 2, { type: 6 }), said(DM, 3, { type: 46 }), said(DM, 4, { type: 3 }))
    expect((await waiting()).chats).toEqual([])
    store(f, said(DM, 5, { type: 19, message_reference: { message_id: msgId(1), channel_id: DM } }))
    expect((await waiting()).chats).toMatchObject([{ waiting: 1, latest: { id: msgId(5) } }])
  })
})

describe("a server channel", () => {
  test("an ordinary message does not wait", async () => {
    store(f, said(CHANNEL, 1), mine(CHANNEL, 2), said(CHANNEL, 3))
    expect((await waiting()).chats).toEqual([])
  })

  test("a reply to the user's message waits", async () => {
    store(f, mine(CHANNEL, 1), replying(CHANNEL, 2, 1), said(CHANNEL, 3))
    expect((await waiting()).chats).toEqual([
      {
        chat: { id: CHANNEL, name: "#general", kind: "text", server: SERVER, server_name: "Test server" },
        why: ["reply"],
        waiting: 1,
        since: idTime(msgId(2)),
        latest: { id: msgId(2), at: idTime(msgId(2)), author_id: ALICE, author: "user02", text: "text 002" },
        current: false,
      },
    ])
  })

  test("a reply to someone else's message, or one the user has answered since, does not", async () => {
    store(f, said(CHANNEL, 1), replying(CHANNEL, 2, 1))
    store(f, mine(OTHER_CHANNEL, 1), replying(OTHER_CHANNEL, 2, 1), mine(OTHER_CHANNEL, 3))
    expect((await waiting()).chats).toEqual([])
  })

  test("a forward of the user's message is not a reply", async () => {
    store(
      f,
      mine(CHANNEL, 1),
      said(CHANNEL, 2, { message_reference: { type: 1, message_id: msgId(1), channel_id: CHANNEL } }),
    )
    expect((await waiting()).chats).toEqual([])
  })

  test("a mention of the user's id waits", async () => {
    store(f, mentioning(CHANNEL, 1), said(CHANNEL, 2))
    expect((await waiting()).chats).toMatchObject([{ chat: { id: CHANNEL }, why: ["mention"], waiting: 1 }])
  })

  test("@everyone, a role and another person do not", async () => {
    store(
      f,
      said(CHANNEL, 1, { mention_everyone: true, content: "@everyone" }),
      said(CHANNEL, 2, { mention_roles: ["1400000000000000555"] }),
      said(CHANNEL, 3, { mentions: [userObject(BOB)] }),
    )
    expect((await waiting()).chats).toEqual([])
  })

  test("a mention the user has answered since does not", async () => {
    store(f, mentioning(CHANNEL, 1), mine(CHANNEL, 2))
    expect((await waiting()).chats).toEqual([])
  })

  test("a reply and a mention in one chat give both reasons, with the first and the latest counted", async () => {
    store(f, mine(CHANNEL, 1), mentioning(CHANNEL, 2), replying(CHANNEL, 3, 1), said(CHANNEL, 4))
    expect((await waiting()).chats).toMatchObject([
      { why: ["reply", "mention"], waiting: 2, since: idTime(msgId(2)), latest: { id: msgId(3) } },
    ])
  })

  test("a thread is a chat of its own, named by its name", async () => {
    store(f, mine(THREAD, 1), replying(THREAD, 2, 1))
    expect((await waiting()).chats).toMatchObject([
      { chat: { id: THREAD, name: "a thread", kind: "thread", server: SERVER }, why: ["reply"] },
    ])
  })

  test("the user's answer in the channel does not answer its thread", async () => {
    store(f, mentioning(THREAD, 1), mine(CHANNEL, 2))
    expect(chatIds(await waiting())).toEqual([THREAD])
  })
})
