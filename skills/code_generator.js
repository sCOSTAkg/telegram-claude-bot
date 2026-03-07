'use strict';

const meta = {
  id: 'code_generator',
  name: 'Code Generator',
  desc: 'Generate production-ready code with tests and documentation',
  category: 'dev',
  tags: ['code', 'programming', 'generator', 'development'],
  inputSchema: { description: 'What to build', language: 'Programming language', framework: 'Framework (optional)' },
  outputFormat: 'text',
  estimatedTime: 'medium',
};

async function execute(params, ctx) {
  const { chatId, callAI } = ctx;
  const { description, language = 'JavaScript', framework = '' } = params;

  const result = await callAI('gemini-2.5-pro', [{
    role: 'user',
    content: `Generate production-ready ${language} code${framework ? ` using ${framework}` : ''}.

Task: ${description || params.task || 'generate code'}

Requirements:
1. Clean, well-structured code
2. Error handling
3. Basic tests
4. Brief usage docs

Return the code in proper code blocks with file names.`
  }], `Senior ${language} developer. Write production-quality code with SOLID principles.`, chatId);

  return result?.text || 'Code generation completed.';
}

module.exports = { meta, execute };
