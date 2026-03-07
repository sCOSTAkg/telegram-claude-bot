'use strict';

const meta = {
  id: 'web_research',
  name: 'Web Research',
  desc: 'Deep web research on any topic with structured report',
  category: 'data',
  tags: ['research', 'web', 'analysis', 'report'],
  inputSchema: { topic: 'Research topic or question' },
  outputFormat: 'text',
  estimatedTime: 'medium',
};

async function execute(params, ctx) {
  const { chatId, callAI } = ctx;
  const topic = params.topic || params.task || 'general research';

  const searchResult = await ctx.executeAction(chatId, { name: 'search', body: topic });
  const searchData = searchResult?.output || searchResult?.text || '';

  const analysis = await callAI('gemini-2.5-flash', [{
    role: 'user',
    content: `Based on this web search data, create a comprehensive research report on "${topic}":\n\n${String(searchData).slice(0, 3000)}\n\nFormat: structured report with sections, key findings, sources.`
  }], 'Research analyst. Write detailed, factual reports in Russian.', chatId);

  return analysis?.text || 'Research completed but no output generated.';
}

module.exports = { meta, execute };
