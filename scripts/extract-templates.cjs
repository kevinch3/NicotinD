#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const glob = require('glob');

/**
 * Extracts inline templates from Angular component files and moves them to separate .html files.
 * Updates component decorators to use templateUrl instead of inline template strings.
 */

const COMPONENT_DIR = path.join(__dirname, '../packages/web/src/app');

async function extractTemplates() {
  // Find all .component.ts files
  const componentFiles = await new Promise((resolve, reject) => {
    glob(`${COMPONENT_DIR}/**/*.component.ts`, (err, files) => {
      if (err) reject(err);
      else resolve(files);
    });
  });

  console.log(`Found ${componentFiles.length} components to process`);

  let successCount = 0;
  let failureCount = 0;

  for (const componentFile of componentFiles) {
    try {
      processComponent(componentFile);
      successCount++;
    } catch (error) {
      console.error(`❌ Failed to process ${componentFile}:`);
      console.error(`   ${error.message}`);
      failureCount++;
    }
  }

  console.log(`\n✅ Extraction complete: ${successCount} succeeded, ${failureCount} failed`);
  if (failureCount > 0) {
    process.exit(1);
  }
}

function processComponent(componentFile) {
  const content = fs.readFileSync(componentFile, 'utf-8');

  // Regex to match: template: `...` where the template can span multiple lines
  // This regex looks for the template property and captures everything between the backticks
  const templateMatch = content.match(/template:\s*`([\s\S]*?)`,?\s*(?=imports:|selector:|styleUrls?:|styles?:|providers?:|directives?:|changeDetection:|encapsulation:|host:|@Component|\n\s*})/);

  if (!templateMatch) {
    throw new Error('No inline template found');
  }

  const templateContent = templateMatch[1];

  // Generate HTML filename
  const dir = path.dirname(componentFile);
  const filename = path.basename(componentFile, '.component.ts');
  const htmlFile = path.join(dir, `${filename}.component.html`);

  // Write HTML file
  fs.writeFileSync(htmlFile, templateContent, 'utf-8');
  console.log(`✓ Created: ${path.relative(process.cwd(), htmlFile)}`);

  // Update component: replace template: `...` with templateUrl: './filename.component.html'
  const updatedContent = content.replace(
    /template:\s*`[\s\S]*?`,?\s*/,
    `templateUrl: './${filename}.component.html',\n  `
  );

  fs.writeFileSync(componentFile, updatedContent, 'utf-8');
  console.log(`✓ Updated: ${path.relative(process.cwd(), componentFile)}`);
}

extractTemplates().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
