#!/usr/bin/env -S deno run -A
/**
 * Test script to verify memory system reliability fixes
 */

import { DBClient } from "../src/db/mod.ts";
import { listMemoryFiles } from "../src/memory/file-writer.ts";
import { needsConsolidation } from "../src/memory/consolidator.ts";

const projectRoot = Deno.cwd();
const db = new DBClient(".psycheros/psycheros.db");

console.log("=== Memory System Fix Verification ===\n");

// Test 1: Check duplicate records exist (they should, from before the fix)
console.log("1. Checking for existing duplicate records...");
const duplicatesQuery = db.getRawDb().prepare(`
  SELECT date, granularity, COUNT(*) as count
  FROM memory_summaries
  GROUP BY date, granularity
  HAVING count > 1
  ORDER BY date
`);
const duplicates = duplicatesQuery.all();
duplicatesQuery.finalize();

if (duplicates.length > 0) {
  console.log(`   Found ${duplicates.length} dates with duplicates:`);
  for (const d of duplicates) {
    console.log(
      `   - ${
        (d as { date: string; granularity: string; count: number }).date
      } (${
        (d as { date: string; granularity: string; count: number }).granularity
      }): ${
        (d as { date: string; granularity: string; count: number }).count
      } records`,
    );
  }
} else {
  console.log("   No duplicates found (good!)");
}

// Test 2: Test upsertMemorySummary prevents new duplicates
console.log("\n2. Testing upsertMemorySummary prevents duplicates...");
const testDate = "2000-01-01"; // Use a test date that won't conflict
const existingBefore = db.getMemorySummary(testDate, "daily");
if (!existingBefore) {
  const id1 = db.upsertMemorySummary(testDate, "daily", "test/path1.md", [
    "chat1",
  ]);
  const id2 = db.upsertMemorySummary(testDate, "daily", "test/path2.md", [
    "chat2",
  ]);
  const id3 = db.upsertMemorySummary(testDate, "daily", "test/path3.md", [
    "chat3",
  ]);

  if (id1 === id2 && id2 === id3) {
    console.log(`   PASS: All three upserts returned the same ID (${id1})`);
  } else {
    console.log(`   FAIL: IDs differ: ${id1}, ${id2}, ${id3}`);
  }

  // Clean up test record
  db.getRawDb().exec("DELETE FROM memory_summaries WHERE date = ?", [testDate]);
  console.log("   Cleaned up test record");
} else {
  console.log("   Skipping - test record already exists");
}

// Test 3: Test getMemorySummary returns existing records
console.log("\n3. Testing getMemorySummary...");
const existingSummary = db.getMemorySummary("2026-02-19", "daily");
if (existingSummary) {
  console.log(`   PASS: Found existing summary for 2026-02-19 (daily)`);
  console.log(`   - ID: ${existingSummary.id}`);
  console.log(`   - File: ${existingSummary.filePath}`);
  console.log(`   - Chat IDs: ${existingSummary.chatIds.length} chats`);
} else {
  console.log("   FAIL: Should have found summary for 2026-02-19");
}

// Test 4: Test listMemoryFiles with includeArchive
console.log("\n4. Testing listMemoryFiles with includeArchive...");
const activeOnly = await listMemoryFiles("daily", projectRoot, false);
const withArchive = await listMemoryFiles("daily", projectRoot, true);
console.log(`   Active files only: ${activeOnly.length}`);
console.log(`   Including archive: ${withArchive.length}`);
if (withArchive.length > activeOnly.length) {
  console.log("   PASS: Archive files are included when requested");
} else if (activeOnly.length === withArchive.length) {
  // Check if archive exists but is empty
  try {
    const archiveDir = `${projectRoot}/memories/archive/daily`;
    let archiveCount = 0;
    for await (const entry of Deno.readDir(archiveDir)) {
      if (entry.isFile && entry.name.endsWith(".md")) archiveCount++;
    }
    if (archiveCount === 0) {
      console.log("   Note: Archive exists but has no .md files");
    } else {
      console.log("   WARNING: Archive has files but they weren't included");
    }
  } catch {
    console.log("   Note: No archive directory exists");
  }
}

// Test 5: Test needsConsolidation for weekly (should find unconsolidated weeks)
console.log("\n5. Testing needsConsolidation for weekly...");
const needsWeekly = await needsConsolidation("weekly", db, projectRoot);
console.log(`   Weekly consolidation needed: ${needsWeekly}`);
if (needsWeekly) {
  console.log("   PASS: System correctly detects unconsolidated daily files");
} else {
  // Check if there are daily files from completed weeks without weekly summaries
  const weeklySummaries = db.getRawDb().prepare(
    "SELECT date FROM memory_summaries WHERE granularity = 'weekly' ORDER BY date",
  ).all();
  weeklySummaries.finalize();
  console.log(`   Current weekly summaries: ${weeklySummaries.length}`);
  console.log(
    "   Note: May need to investigate why consolidation isn't needed",
  );
}

// Test 6: Show what weeks need consolidation
console.log("\n6. Checking which weeks need consolidation...");
const now = new Date();
const currentWeekStart = new Date(now);
const day = currentWeekStart.getDay();
const diff = currentWeekStart.getDate() - day + (day === 0 ? -6 : 1);
currentWeekStart.setDate(diff);
currentWeekStart.setHours(0, 0, 0, 0);

// Get previous week start
const prevWeekStart = new Date(currentWeekStart);
prevWeekStart.setDate(prevWeekStart.getDate() - 7);

// Get all daily files from before current week
const dailyFiles = await listMemoryFiles("daily", projectRoot, true);
const unconsolidatedWeeks = new Set<string>();

for (const file of dailyFiles) {
  const match = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  if (match) {
    const fileDate = new Date(match[1]);
    if (fileDate < currentWeekStart) {
      // Calculate week number
      const jan1 = new Date(fileDate.getFullYear(), 0, 1);
      const daysDiff = Math.floor(
        (fileDate.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000),
      );
      const weekNum = Math.ceil((daysDiff + jan1.getDay() + 1) / 7);
      const weekStr = `${fileDate.getFullYear()}-W${
        String(weekNum).padStart(2, "0")
      }`;

      // Check if this week has a summary
      const weekSummary = db.getMemorySummary(weekStr, "weekly");
      if (!weekSummary) {
        unconsolidatedWeeks.add(weekStr);
      }
    }
  }
}

if (unconsolidatedWeeks.size > 0) {
  console.log(
    `   Found ${unconsolidatedWeeks.size} weeks needing consolidation:`,
  );
  for (const week of Array.from(unconsolidatedWeeks).sort()) {
    console.log(`   - ${week}`);
  }
} else {
  console.log("   All weeks are consolidated (or no daily files exist)");
}

console.log("\n=== Verification Complete ===\n");

db.close();
