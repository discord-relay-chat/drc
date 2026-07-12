(function () {
  'use strict';

  console.log('Template switcher loaded - version 2024-10-24-15:10');

  const TEMPLATE_TYPES = {
    digest: 'digestVariants',
    ai: 'aiVariants',
    claudecode: 'claudecodeVariants'
  };

  function getCurrentTemplateType () {
    const title = document.title.toLowerCase();

    if (title.includes('digest') || title.includes('message')) {
      return 'digest';
    } else if (title.includes('claude code')) {
      return 'claudecode';
    } else if (title.includes('ai') || title.includes('response')) {
      return 'ai';
    }

    return null;
  }

  function getCurrentVariant () {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('template') || 'default';
  }

  function createTemplateSwitcher (variants, currentVariant) {
    const container = document.createElement('div');
    container.id = 'template-switcher';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 8px;
      padding: 12px 16px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(10px);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    `;

    const label = document.createElement('label');
    label.textContent = 'Theme: ';
    label.style.cssText = `
      color: rgba(255, 255, 255, 0.9);
      font-size: 13px;
      font-weight: 500;
      margin-right: 8px;
    `;

    const select = document.createElement('select');
    select.style.cssText = `
      background: white;
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 4px;
      padding: 6px 28px 6px 10px;
      font-size: 13px;
      cursor: pointer;
      outline: none;
      transition: all 0.2s ease;
    `;
    select.style.color = 'black';

    select.addEventListener('mouseenter', () => {
      select.style.background = '#f0f0f0';
    });

    select.addEventListener('mouseleave', () => {
      select.style.background = 'white';
    });

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default';
    if (currentVariant === 'default') {
      defaultOption.selected = true;
    }
    select.appendChild(defaultOption);

    variants.forEach((variant) => {
      const option = document.createElement('option');
      option.value = variant;
      option.textContent = variant.split('-').map(word =>
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(' ');

      if (variant === currentVariant) {
        option.selected = true;
      }

      select.appendChild(option);
    });

    select.addEventListener('change', (e) => {
      const selectedVariant = e.target.value;
      const url = new URL(window.location.href);

      if (selectedVariant) {
        url.searchParams.set('template', selectedVariant);
      } else {
        url.searchParams.delete('template');
      }

      window.location.href = url.toString();
    });

    container.appendChild(label);
    container.appendChild(select);

    // Force color to black after DOM insertion
    setTimeout(() => {
      select.style.color = 'black';
      console.log('Template switcher: Force set color to black. Current value:', select.style.color);
    }, 0);

    return container;
  }

  async function initTemplateSwitcher () {
    try {
      const templateType = getCurrentTemplateType();

      if (!templateType || !TEMPLATE_TYPES[templateType]) {
        console.log('Template switcher: Not a digest or ai template');
        return;
      }

      const response = await fetch('/api/templates');
      if (!response.ok) {
        throw new Error(`Failed to fetch templates: ${response.status}`);
      }

      const data = await response.json();
      const variants = data[TEMPLATE_TYPES[templateType]] || [];

      if (variants.length === 0) {
        console.warn('No template variants found');
        return;
      }

      const currentVariant = getCurrentVariant();
      const switcher = createTemplateSwitcher(variants, currentVariant, templateType);

      document.body.appendChild(switcher);

      console.log(`Template switcher initialized for ${templateType} with ${variants.length} variants`);
    } catch (error) {
      console.error('Error initializing template switcher:', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTemplateSwitcher);
  } else {
    initTemplateSwitcher();
  }
})();
