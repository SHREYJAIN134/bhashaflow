// "Provider" that answers with the hand-written reference renderings in cases.json. It validates the
// benchmark itself (references must pass the validator) and is a ceiling for the formatting checks.
// It says nothing about any real model.
export function createReferenceProvider(cases) {
  const byText = new Map(cases.map((c) => [c.text, c.reference]));
  return {
    name: 'reference',
    model: 'hand-written',
    async complete({ user }) {
      const request = JSON.parse(user);
      const results = request.items.map((it) => ({ id: it.id, hinglish: byText.get(it.text) ?? it.text }));
      return { text: JSON.stringify({ results }), usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
