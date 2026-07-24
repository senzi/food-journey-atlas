import { handleJourneyQuery } from "../../worker/journey-query";

interface Env {
  deepseek_key?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
}

interface PagesContext {
  request: Request;
  env: Env;
}

export function onRequest(context: PagesContext) {
  return handleJourneyQuery(context.request, context.env);
}
