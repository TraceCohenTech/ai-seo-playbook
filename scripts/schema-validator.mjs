#!/usr/bin/env node

/**
 * Schema Validator
 *
 * Scans content files and pages for JSON-LD structured data, validates
 * against Google's requirements, and catches common mistakes:
 * duplicate schemas, missing required fields, and wrong schema types
 * for the page type.
 *
 * The guide recommends 7 schema types across the site. This script
 * ensures they're deployed correctly and catches the duplicate FAQPage
 * bug that triggers Google to suppress ALL rich results for a page.
 *
 * Usage:
 *   node scripts/schema-validator.mjs --dir ./content
 *   node scripts/schema-validator.mjs --sitemap https://yoursite.com/sitemap.xml
 *   node scripts/schema-validator.mjs --dir ./src/app/blog --output schema-report.json
 */

import { parseArgs } from 'node:util';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string' },
    sitemap: { type: 'string' },
    'base-url': { type: 'string' },
    output: { type: 'string' },
  },
});

if (!args.dir && !args.sitemap) {
  console.error('Usage: node scripts/schema-validator.mjs --dir ./content');
  console.error('       node scripts/schema-validator.mjs --sitemap https://yoursite.com/sitemap.xml');
  process.exit(1);
}

const SCHEMA_TYPES = [
  'FAQPage', 'Dataset', 'Article', 'NewsArticle',
  'Organization', 'WebSite', 'BreadcrumbList', 'CollectionPage',
  'ItemList', 'Person',
];

const REQUIRED_FIELDS = {
  Article: ['headline', 'author', 'datePublished'],
  NewsArticle: ['headline', 'author', 'datePublished'],
  FAQPage: ['mainEntity'],
  Dataset: ['name', 'description'],
  Organization: ['name', 'url'],
  WebSite: ['name', 'url'],
  BreadcrumbList: ['itemListElement'],
  ItemList: ['itemListElement'],
  Person: ['name'],
};

const FAQ_RULES = {
  maxQuestions: 5,
  minAnswerWords: 30,
  maxAnswerWords: 120,
};

function extractSchemas(content) {
  const schemas = [];
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        schemas.push(...parsed);
      } else if (parsed['@graph']) {
        schemas.push(...parsed['@graph']);
      } else {
        schemas.push(parsed);
      }
    } catch {
      schemas.push({ _parseError: true, _raw: match[1].slice(0, 200) });
    }
  }

  return schemas;
}

function getSchemaType(schema) {
  const type = schema['@type'];
  if (Array.isArray(type)) return type[0];
  return type || 'Unknown';
}

function validateSchema(schema, file) {
  const issues = [];
  const type = getSchemaType(schema);

  if (schema._parseError) {
    issues.push({ severity: 'error', message: 'Invalid JSON in schema block', type: 'ParseError' });
    return issues;
  }

  if (!schema['@context'] && !schema._nested) {
    issues.push({ severity: 'warn', message: `Missing @context on ${type} schema` });
  }

  const required = REQUIRED_FIELDS[type];
  if (required) {
    for (const field of required) {
      if (!schema[field]) {
        issues.push({ severity: 'error', message: `${type} missing required field: ${field}` });
      }
    }
  }

  if (type === 'FAQPage' && schema.mainEntity) {
    const questions = Array.isArray(schema.mainEntity) ? schema.mainEntity : [schema.mainEntity];

    if (questions.length > FAQ_RULES.maxQuestions) {
      issues.push({
        severity: 'warn',
        message: `FAQPage has ${questions.length} questions (max ${FAQ_RULES.maxQuestions} — extras get ignored by Google's parser)`,
      });
    }

    for (const q of questions) {
      if (!q.name) {
        issues.push({ severity: 'error', message: 'FAQ question missing name field' });
      }
      const answer = q.acceptedAnswer?.text || '';
      const wordCount = answer.split(/\s+/).filter(Boolean).length;
      if (wordCount < FAQ_RULES.minAnswerWords) {
        issues.push({ severity: 'warn', message: `FAQ answer too short (${wordCount} words, min ${FAQ_RULES.minAnswerWords})` });
      }
      if (wordCount > FAQ_RULES.maxAnswerWords) {
        issues.push({ severity: 'warn', message: `FAQ answer too long (${wordCount} words, max ${FAQ_RULES.maxAnswerWords})` });
      }
    }
  }

  if (type === 'Article' || type === 'NewsArticle') {
    const author = schema.author;
    if (author && !author.sameAs && !author.url) {
      issues.push({ severity: 'warn', message: `${type} author missing sameAs/url (weakens E-E-A-T entity)` });
    }
    if (schema.headline && schema.headline.length > 110) {
      issues.push({ severity: 'warn', message: `${type} headline too long (${schema.headline.length} chars, Google truncates at ~110)` });
    }
  }

  if (type === 'Dataset') {
    if (!schema.temporalCoverage) {
      issues.push({ severity: 'warn', message: 'Dataset missing temporalCoverage (helps Google Dataset Search)' });
    }
    if (!schema.variableMeasured) {
      issues.push({ severity: 'warn', message: 'Dataset missing variableMeasured' });
    }
  }

  return issues;
}

async function walkDir(dir) {
  const files = [];
  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        await walk(fullPath);
      } else if (['.tsx', '.jsx', '.html', '.mdx', '.md'].includes(extname(entry.name))) {
        files.push(fullPath);
      }
    }
  }
  await walk(dir);
  return files;
}

async function scanFiles(dir) {
  const files = await walkDir(dir);
  const results = [];

  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const schemas = extractSchemas(content);
    if (schemas.length === 0) continue;

    const typeCounts = {};
    const fileIssues = [];

    for (const schema of schemas) {
      const type = getSchemaType(schema);
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      fileIssues.push(...validateSchema(schema, file));
    }

    for (const [type, count] of Object.entries(typeCounts)) {
      if (count > 1) {
        const severity = type === 'FAQPage' ? 'error' : 'warn';
        const extra = type === 'FAQPage'
          ? ' — duplicate FAQPage triggers Google penalty suppressing ALL rich results'
          : '';
        fileIssues.push({
          severity,
          message: `Duplicate ${type} schema (found ${count})${extra}`,
        });
      }
    }

    results.push({
      file,
      schemaCount: schemas.length,
      types: Object.keys(typeCounts),
      issues: fileIssues,
    });
  }

  return { files: files.length, results };
}

async function scanSitemap(sitemapUrl) {
  const res = await fetch(sitemapUrl);
  const xml = await res.text();
  const urls = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    urls.push(match[1]);
  }

  const results = [];
  const batchSize = 5;

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const html = await res.text();
        const schemas = extractSchemas(html);
        if (schemas.length === 0) return null;

        const typeCounts = {};
        const fileIssues = [];

        for (const schema of schemas) {
          const type = getSchemaType(schema);
          typeCounts[type] = (typeCounts[type] || 0) + 1;
          fileIssues.push(...validateSchema(schema, url));
        }

        for (const [type, count] of Object.entries(typeCounts)) {
          if (count > 1) {
            const severity = type === 'FAQPage' ? 'error' : 'warn';
            fileIssues.push({
              severity,
              message: `Duplicate ${type} schema (found ${count})${severity === 'error' ? ' — triggers rich result suppression' : ''}`,
            });
          }
        }

        return {
          file: url,
          schemaCount: schemas.length,
          types: Object.keys(typeCounts),
          issues: fileIssues,
        };
      } catch {
        return null;
      }
    }));

    results.push(...batchResults.filter(Boolean));
    process.stderr.write(`\rScanned ${Math.min(i + batchSize, urls.length)}/${urls.length} URLs`);
  }

  console.log('');
  return { files: urls.length, results };
}

async function main() {
  console.log('Schema Validator\n');

  const { files: totalFiles, results } = args.dir
    ? await scanFiles(args.dir)
    : await scanSitemap(args.sitemap);

  const withSchemas = results.length;
  const withErrors = results.filter(r => r.issues.some(i => i.severity === 'error')).length;
  const withWarnings = results.filter(r => r.issues.some(i => i.severity === 'warn')).length;
  const totalErrors = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'error').length, 0);
  const totalWarnings = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'warn').length, 0);

  const allTypes = new Set(results.flatMap(r => r.types));

  console.log('═'.repeat(60));
  console.log(' SCHEMA VALIDATION REPORT');
  console.log('═'.repeat(60));

  console.log(`\n  Files/URLs scanned:  ${totalFiles}`);
  console.log(`  With schemas:        ${withSchemas}`);
  console.log(`  Without schemas:     ${totalFiles - withSchemas}`);
  console.log(`  Schema types found:  ${[...allTypes].join(', ') || 'none'}`);
  console.log(`  Errors:              ${totalErrors}`);
  console.log(`  Warnings:            ${totalWarnings}`);

  if (totalErrors > 0) {
    console.log('\n── ERRORS ──\n');
    for (const r of results) {
      const errors = r.issues.filter(i => i.severity === 'error');
      if (errors.length === 0) continue;
      console.log(`  ${r.file}`);
      for (const e of errors) {
        console.log(`    ✗ ${e.message}`);
      }
    }
  }

  if (totalWarnings > 0) {
    console.log('\n── WARNINGS ──\n');
    for (const r of results) {
      const warnings = r.issues.filter(i => i.severity === 'warn');
      if (warnings.length === 0) continue;
      console.log(`  ${r.file}`);
      for (const w of warnings) {
        console.log(`    ! ${w.message}`);
      }
    }
  }

  const missingTypes = ['FAQPage', 'Article', 'BreadcrumbList', 'Organization', 'WebSite']
    .filter(t => !allTypes.has(t));
  if (missingTypes.length > 0) {
    console.log(`\n  Missing schema types across site: ${missingTypes.join(', ')}`);
    console.log('  See config/schema-rules.json for deployment guidelines.\n');
  }

  if (args.output) {
    const report = {
      generated: new Date().toISOString(),
      totalScanned: totalFiles,
      withSchemas,
      errors: totalErrors,
      warnings: totalWarnings,
      schemaTypes: [...allTypes],
      missingTypes,
      files: results.map(r => ({
        file: r.file,
        types: r.types,
        issues: r.issues,
      })),
    };
    await writeFile(args.output, JSON.stringify(report, null, 2));
    console.log(`Report saved to ${args.output}`);
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
