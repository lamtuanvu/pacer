#!/usr/bin/env bun
import { serve, type PluginManifest } from '@pacer/plugin';
import manifest from './pacer-plugin.json';
import { createBudgetPolicy } from './budget';

if (import.meta.main) await serve({ manifest: manifest as PluginManifest, ...createBudgetPolicy() });
