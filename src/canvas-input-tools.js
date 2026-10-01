const CANVAS_INPUT_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'request_canvas_input',
      description: 'Ask the user to choose in the actual canvas, persist the answer and automatically continue this conversation after their click. Ends this agent turn immediately without polling. Choice UI is temporary and does not replace saved source. One pending request per canvas.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['question', 'options'],
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 1000 },
          options: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['value', 'label'], properties: { value: { type: 'string', minLength: 1, maxLength: 128 }, label: { type: 'string', minLength: 1, maxLength: 240 } } } },
          afterSubmit: { type: 'string', enum: ['clear', 'restorePreviousView', 'resetState'], description: 'clear/restorePreviousView dismiss the temporary choice overlay, revealing the existing canvas. resetState reloads saved source without preserved runtime state. The answer is saved first.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_canvas_inputs',
      description: 'Read pending questions and saved canvas responses for this conversation, with bounded metadata. Do not poll waiting for a click; request_canvas_input ends the turn and resumes automatically.',
      parameters: { type: 'object', additionalProperties: false, properties: { canvasId: { type: 'string', pattern: '^[a-f0-9]{32}$' }, limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    },
  },
]);

module.exports = { CANVAS_INPUT_TOOLS };
