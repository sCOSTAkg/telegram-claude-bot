'use strict';

const meta = {
  id: 'business_analysis',
  name: 'Business Analysis',
  desc: 'Comprehensive business analysis: market, competitors, SWOT, strategy',
  category: 'business',
  tags: ['business', 'analysis', 'strategy', 'market', 'swot'],
  inputSchema: { business: 'Business description or niche', goal: 'Analysis goal' },
  outputFormat: 'text',
  estimatedTime: 'slow',
};

async function execute(params, ctx) {
  const { chatId, callAI } = ctx;
  const { business, goal = 'full analysis' } = params;
  const topic = business || params.task || 'business';

  // Market research
  let searchData = '';
  try {
    const search = await ctx.executeAction(chatId, { name: 'search', body: `${topic} market analysis trends 2025 2026` });
    searchData = String(search?.output || search?.text || '').slice(0, 2000);
  } catch {}

  const analysis = await callAI('gemini-2.5-pro', [{
    role: 'user',
    content: `Conduct comprehensive business analysis. Language: Russian.

Business: ${topic}
Goal: ${goal}
Market data: ${searchData}

Include:
1. Market overview and trends
2. Target audience analysis
3. Competitor landscape
4. SWOT analysis
5. Revenue model options
6. Growth strategy recommendations
7. Key risks and mitigation
8. Action plan (first 90 days)

Be specific, data-driven, actionable.`
  }], 'Senior business analyst with 15+ years experience. Provide actionable, data-backed analysis in Russian.', chatId);

  return analysis?.text || 'Business analysis completed.';
}

module.exports = { meta, execute };
