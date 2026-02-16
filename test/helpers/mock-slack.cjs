/**
 * Mock Slack WebClient factory for tests.
 * Returns an object that mimics @slack/web-api WebClient methods.
 * Uses a deterministic counter for IDs instead of Date.now().
 */

function createMockSlackClient() {
  const calls = [];
  let nextId = 1;

  function record(method, args) {
    calls.push({ method, args });
  }

  const client = {
    conversations: {
      create: async (opts) => {
        record('conversations.create', opts);
        return {
          channel: {
            id: `C${String(nextId++).padStart(6, '0')}`,
            name: opts.name,
          },
        };
      },
      setTopic: async (opts) => {
        record('conversations.setTopic', opts);
        return { ok: true };
      },
      invite: async (opts) => {
        record('conversations.invite', opts);
        return { ok: true };
      },
      archive: async (opts) => {
        record('conversations.archive', opts);
        return { ok: true };
      },
      history: async (opts) => {
        record('conversations.history', opts);
        return { messages: [{ ts: '1234567890.000001' }] };
      },
    },
    chat: {
      postMessage: async (opts) => {
        record('chat.postMessage', opts);
        return { ok: true, ts: `${String(nextId++).padStart(10, '0')}.000001` };
      },
      update: async (opts) => {
        record('chat.update', opts);
        return { ok: true };
      },
    },
    reactions: {
      add: async (opts) => {
        record('reactions.add', opts);
        return { ok: true };
      },
      remove: async (opts) => {
        record('reactions.remove', opts);
        return { ok: true };
      },
    },
  };

  return { client, calls };
}

module.exports = { createMockSlackClient };
