// Kiro API configuration — API key (ksk_) auth.
//
// Protocol notes (reverse-engineered from kiro-cli traffic):
//   - Chat goes to the ROOT path of the runtime host, not /generateAssistantResponse
//   - Model list + profile live on a SEPARATE management host
//   - "tokentype: API_KEY" header is mandatory, else 403 "bearer token is invalid"
//   - User-Agent must carry app/AmazonQ-For-CLI, else 403 AccessDeniedException
//   - Request body must NOT include profileArn, and origin must be KIRO_CLI

export const RUNTIME_HOST_TEMPLATE = "https://runtime.{region}.kiro.dev";
export const MANAGEMENT_HOST_TEMPLATE = "https://management.{region}.kiro.dev";

export const DEFAULT_REGION = "us-east-1";

// Origin the API key is authorized for.
export const ORIGIN = "KIRO_CLI";

// x-amz-target values
export const TARGET_CHAT = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
export const TARGET_LIST_MODELS = "AmazonCodeWhispererService.ListAvailableModels";
export const TARGET_GET_PROFILE = "AmazonCodeWhispererService.GetProfile";

// The app identity in these strings is what authorizes API-key calls. Do not trim it.
export const USER_AGENT =
  "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/linux lang/rust/1.92.0 md/appVersion-2.14.2 app/AmazonQ-For-CLI";
export const X_AMZ_USER_AGENT =
  "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/linux lang/rust/1.92.0 m/F app/AmazonQ-For-CLI";

export function getRuntimeHost(region = DEFAULT_REGION) {
  return RUNTIME_HOST_TEMPLATE.replace("{region}", region);
}

export function getManagementHost(region = DEFAULT_REGION) {
  return MANAGEMENT_HOST_TEMPLATE.replace("{region}", region);
}
