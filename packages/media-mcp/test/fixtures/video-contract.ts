export const capabilities = {
  object: 'video.capabilities', schema_version: 1, model: 'ltx-2.5', fps: 24,
  seconds: { min: 1, max: 12, default: 4 }, sizes: ['512x320', '1280x720'], default_size: '1280x720',
  seed: { min: '0', max: '18446744073709551614', encoding: 'decimal_string' },
  loras: { max_count: 4, min_strength: 0, max_strength: 2, default_strength: 1, camera_default_strength: 0.8, catalog_path: '/v1/videos/loras' },
  motion_speed: { min: 0.025, max: 1, requires_lora: 'slow-motion' },
  lora_reference_strength: { min: 0, max: 1, default: 1, requires_lora: 'ingredients' },
  uploads: { mime_types: ['image/png', 'image/jpeg', 'image/webp'], max_total_bytes: 33554432 },
  guiding_frames: { supported: true, available: false, validation: 'graph_contract_tested', max_count: 8, frame_index_multiple: 1, min_strength: 0, max_strength: 1, default_strength: 1, exclusive_with: ['input_reference', 'lora_reference', 'ingredients'] },
};
