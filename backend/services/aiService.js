const Anthropic = require('@anthropic-ai/sdk');

<<<<<<< HEAD
// Initialize only when a Claude endpoint is used so OpenAI try-on can run independently.
let anthropic;
function getAnthropic() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}
=======
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
>>>>>>> 61b8ef536785e623ebbe0c633b55f13aa576a28f

/**
 * Tags a clothing image: category, dominant color, season, and free-form tags.
 * imageBase64 should be a base64-encoded JPEG/PNG (no data: prefix).
 */
async function tagClothingImage(imageBase64, mediaType = 'image/jpeg') {
<<<<<<< HEAD
  const message = await getAnthropic().messages.create({
=======
  const message = await anthropic.messages.create({
>>>>>>> 61b8ef536785e623ebbe0c633b55f13aa576a28f
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageBase64 },
          },
          {
            type: 'text',
            text:
              'Look at this clothing item photo. Respond with ONLY a JSON object, no markdown, ' +
              'no preamble, in exactly this shape: ' +
              '{"category": "top|bottom|dress|outerwear|shoes|accessory", "color": "primary color name", ' +
              '"season": "summer|winter|monsoon|all", "tags": ["short", "descriptive", "tags"]}',
          },
        ],
      },
    ],
  });

  const text = message.content.find((b) => b.type === 'text')?.text ?? '{}';
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Generates an outfit recommendation from the user's wardrobe.
 * items: array of { id, category, color, season, tags }
 */
async function generateOutfit({ items, occasion, weather }) {
  const wardrobeSummary = items
    .map((i) => `- id:${i.id} | ${i.category} | ${i.color} | season:${i.season} | tags:${(i.tags || []).join(',')}`)
    .join('\n');

<<<<<<< HEAD
  const message = await getAnthropic().messages.create({
=======
  const message = await anthropic.messages.create({
>>>>>>> 61b8ef536785e623ebbe0c633b55f13aa576a28f
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [
      {
        role: 'user',
        content:
          `Here is a user's wardrobe:\n${wardrobeSummary}\n\n` +
          `Occasion: ${occasion}\nWeather: ${weather}\n\n` +
          'Pick a coherent outfit (2-4 items) from this wardrobe only, using the exact ids given. ' +
          'Respond with ONLY JSON, no markdown: {"itemIds": ["id1","id2"], "reasoning": "one or two friendly sentences explaining the choice"}',
      },
    ],
  });

  const text = message.content.find((b) => b.type === 'text')?.text ?? '{}';
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { tagClothingImage, generateOutfit };
