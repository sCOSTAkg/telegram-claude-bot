'use strict';

const meta = {
  id: 'content_pipeline',
  name: 'Content Pipeline',
  desc: 'Full content creation pipeline: research -> outline -> draft -> edit -> publish-ready',
  category: 'creative',
  tags: ['content', 'writing', 'copywriting', 'pipeline'],
  inputSchema: { topic: 'Content topic', format: 'article|post|script|email', audience: 'Target audience' },
  outputFormat: 'text',
  estimatedTime: 'slow',
};

async function execute(params, ctx) {
  const { chatId, callAI } = ctx;
  const { topic, format = 'article', audience = 'general' } = params;

  // Step 1: Research
  const research = await callAI('gemini-2.5-flash', [{
    role: 'user',
    content: `Research key points for ${format} about "${topic}" for ${audience} audience. Return 5-7 key points with supporting facts.`
  }], '', chatId);

  // Step 2: Outline
  const outline = await callAI('gemini-2.5-flash', [{
    role: 'user',
    content: `Create a detailed outline for ${format} about "${topic}".\nResearch:\n${(research?.text || '').slice(0, 1500)}\nFormat: structured outline with H2/H3 headers, bullet points.`
  }], '', chatId);

  // Step 3: Draft
  const draft = await callAI('gemini-2.5-pro', [{
    role: 'user',
    content: `Write a complete ${format} based on this outline. Language: Russian. Audience: ${audience}.\n\n${(outline?.text || '').slice(0, 2000)}\n\nRequirements: engaging, well-structured, professional tone.`
  }], 'Expert content writer. Write compelling, well-researched content in Russian.', chatId);

  // Step 4: Edit & Polish
  const final = await callAI('gemini-2.5-flash', [{
    role: 'user',
    content: `Edit and polish this ${format}. Fix any issues, improve flow, add strong intro and CTA.\n\n${(draft?.text || '').slice(0, 4000)}`
  }], 'Editor. Polish text for clarity, engagement, and impact. Reply in Russian.', chatId);

  return final?.text || draft?.text || 'Content pipeline completed.';
}

module.exports = { meta, execute };
