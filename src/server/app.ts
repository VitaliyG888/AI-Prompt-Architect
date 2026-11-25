/**
 * Сборка приложения: единый контейнер зависимостей и регистрация всех
 * компонентов. Никакой циклической логики: движки получают зависимости
 * через конструктор, API-слой работает только через этот контейнер.
 */
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db/schema.ts';
import { ProjectRepository } from './db/repo/projects.ts';
import { SectionRepository } from './db/repo/sections.ts';
import { MessageRepository } from './db/repo/messages.ts';
import { SourceRepository } from './db/repo/sources.ts';
import { ProviderRepository } from './db/repo/providers.ts';
import { RouteRepository } from './db/repo/routes.ts';
import { SearchProviderRepository } from './db/repo/search.ts';
import { SettingsRepository } from './db/repo/settings.ts';
import { UsageRepository } from './db/repo/usage.ts';
import { VersionRepository } from './db/repo/versions.ts';
import { TestRunRepository } from './db/repo/tests.ts';
import { LLMClient } from './llm/client.ts';
import { ConnectionTester } from './llm/connection-test.ts';
import { SearchEngine } from './search/engine.ts';
import { InterviewEngine } from './engines/interview.ts';
import { ResearchEngine } from './engines/research.ts';
import { SectionArchitect } from './engines/section-architect.ts';
import { PromptAssembler } from './engines/assembler.ts';
import { PromptTester } from './engines/tester.ts';
import { PromptOrchestrator } from './engines/orchestrator.ts';
import { config } from './env.ts';
import { log } from './core/logger.ts';

export interface AppContainer {
  db: DatabaseSync;
  projects: ProjectRepository;
  sections: SectionRepository;
  messages: MessageRepository;
  sources: SourceRepository;
  providers: ProviderRepository;
  routes: RouteRepository;
  searchProviders: SearchProviderRepository;
  settings: SettingsRepository;
  usage: UsageRepository;
  versions: VersionRepository;
  tests: TestRunRepository;
  client: LLMClient;
  connectionTester: ConnectionTester;
  search: SearchEngine;
  interview: InterviewEngine;
  research: ResearchEngine;
  architect: SectionArchitect;
  assembler: PromptAssembler;
  tester: PromptTester;
  orchestrator: PromptOrchestrator;
  close: () => void;
}

export interface CreateAppOptions {
  /** Путь к базе. ':memory:' — для тестов. */
  databasePath?: string;
  /** Разрешить приватные адреса провайдеров (для локальных mock-серверов). */
  allowPrivateProviders?: boolean;
}

export function createApp(options: CreateAppOptions = {}): AppContainer {
  const db = openDatabase(options.databasePath);

  const projects = new ProjectRepository(db);
  const sections = new SectionRepository(db);
  const messages = new MessageRepository(db);
  const sources = new SourceRepository(db);
  const providers = new ProviderRepository(db);
  const routes = new RouteRepository(db);
  const searchProviders = new SearchProviderRepository(db);
  const settings = new SettingsRepository(db);
  const usage = new UsageRepository(db);
  const versions = new VersionRepository(db);
  const tests = new TestRunRepository(db);

  const allowPrivate = options.allowPrivateProviders ?? config.allowPrivateProviders;

  const client = new LLMClient({ providers, routes, usage, settings, allowPrivate });
  const connectionTester = new ConnectionTester(providers, { allowPrivate });
  const search = new SearchEngine(searchProviders, {
    allowPrivate,
    defaultLimit: settings.defaults().maxSourcesPerSection,
  });

  const interview = new InterviewEngine({ client, projects, sections, messages });
  const research = new ResearchEngine({ client, search, sources, sections, settings });
  const architect = new SectionArchitect({ client, sections, sources, projects });
  const assembler = new PromptAssembler(client);
  const tester = new PromptTester(client);

  const orchestrator = new PromptOrchestrator({
    projects,
    sections,
    messages,
    sources,
    versions,
    settings,
    interview,
    research,
    architect,
    assembler,
    tester,
    client,
  });

  // Регистрируем дефолтные маршруты, если их ещё нет: наследование работает
  // предсказуемо, а пользователь видит все операции в интерфейсе.
  if (routes.list().length === 0) {
    const defaults = settings.defaults();
    for (const operation of [
      'interview',
      'answer_analysis',
      'question_planning',
      'research_queries',
      'source_analysis',
      'example_comparison',
      'section_synthesis',
      'quality_check',
      'final_assembly',
      'test_generation',
      'test_evaluation',
    ] as const) {
      routes.upsert(operation, {
        providerId: null,
        model: '',
        params: {},
        fallbackProviderId: null,
        fallbackModel: '',
        useFallback: false,
      });
    }
    void defaults;
  }

  log.info('app initialized', {
    providers: providers.list().length,
    searchProviders: searchProviders.list().length,
    projects: projects.count(),
  });

  return {
    db,
    projects,
    sections,
    messages,
    sources,
    providers,
    routes,
    searchProviders,
    settings,
    usage,
    versions,
    tests,
    client,
    connectionTester,
    search,
    interview,
    research,
    architect,
    assembler,
    tester,
    orchestrator,
    close: () => db.close(),
  };
}
