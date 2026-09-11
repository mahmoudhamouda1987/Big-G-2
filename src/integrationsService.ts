import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";

export interface BigGEmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  from: string;
  enableTls: boolean;
}

export interface BigGIntegrationConfig {
  email?: Partial<BigGEmailConfig>;
  gmailToken?: string;
  calendarToken?: string;
  calendarId?: string;
}

/**
 * IntegrationsService — email + calendar over the gate-protected bridge.
 *
 * Configuration is read live from the Big G memory preferences:
 *   smtp_host / smtp_port / smtp_user / smtp_pass / smtp_from / smtp_tls
 *   gmail_token / calendar_token / calendar_id
 *
 * All work is executed as generated PowerShell scripts written into the
 * same app-data script folder the CommandGate auto-allows, so no arbitrary
 * shell access is created — only these constrained, single-purpose scripts.
 */
export class IntegrationsService {
  private scriptDir: string | null = null;

  constructor(private readonly getConfig: () => BigGIntegrationConfig) {}

  /* ------------------------------------------------------------------ */
  /* Email                                                               */
  /* ------------------------------------------------------------------ */

  async sendEmail(args: { to: string; subject: string; body: string }): Promise<string> {
    const cfg = this.getConfig();
    const host = cfg.email?.smtpHost;
    if (!host) {
      return missingConfig(
        "send_email",
        "smtp_host",
        'Tell Big G your SMTP settings, e.g. "my SMTP host is smtp.gmail.com, port 587, user me@gmail.com, app password abcd".',
      );
    }

    const port = cfg.email?.smtpPort ?? 587;
    const user = cfg.email?.smtpUser ?? "";
    const pass = cfg.email?.smtpPass ?? "";
    const from = cfg.email?.from ?? user;
    const tls = cfg.email?.enableTls ?? true;

    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$h = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(host)}'))`,
      `$u = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(user)}'))`,
      `$p = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(pass)}'))`,
      `$f = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(from)}'))`,
      `$to = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(args.to)}'))`,
      `$$subj = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(args.subject)}'))`,
      `$$body = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(args.body)}'))`,
      "$smtp = New-Object System.Net.Mail.SmtpClient($h, {{PORT}})",
      "$smtp.EnableSsl = ${{TLS}}",
      "$smtp.Credentials = New-Object System.Net.NetworkCredential($u, $p)",
      "$msg = New-Object System.Net.Mail.MailMessage($f, $to)",
      "$msg.Subject = $subj",
      "$msg.Body = $body",
      "$msg.IsBodyHtml = $false",
      "$smtp.Send($msg)",
      'Write-Output ("email sent to " + $to)',
    ]
      .join("\n")
      .replace("{{PORT}}", String(port))
      .replace("{{TLS}}", tls ? "$true" : "$false");

    return this.runScript(script);
  }

  async readEmails(max = 10, labels = "INBOX"): Promise<string> {
    const token = this.token("gmail");
    if (!token) return missingConfig("read_emails", "gmail_token", "");

    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(token)}'))`,
      `$q = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(`in:${labels}`)}'))`,
      `$headers = @{ Authorization = 'Bearer ' + $t }`,
      `$list = Invoke-RestMethod -Uri ('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' + ${max} + '&q=' + [uri]::EscapeDataString($q)) -Headers $headers -Method Get`,
      "$out = @()",
      "foreach ($m in @($list.messages)) {",
      "  try {",
      "    $d = Invoke-RestMethod -Uri ('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + $m.id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date') -Headers $headers -Method Get",
      "    $subj = ($d.payload.headers | Where-Object { $_.name -eq 'Subject' }).value",
      "    $fr = ($d.payload.headers | Where-Object { $_.name -eq 'From' }).value",
      "    $dt = ($d.payload.headers | Where-Object { $_.name -eq 'Date' }).value",
      "    $out += ('[' + $dt + '] ' + $fr + ' - ' + $subj)",
      "  } catch { }",
      "}",
      "Write-Output ('inbox (' + $out.Count + ' messages):')",
      "$out | Out-String",
    ].join("\n");

    return this.runScript(script);
  }

  /* ------------------------------------------------------------------ */
  /* Calendar                                                            */
  /* ------------------------------------------------------------------ */

  async listCalendarEvents(max = 10): Promise<string> {
    const token = this.token("calendar");
    const cal = this.calendarId();
    if (!token) return missingConfig("list_calendar_events", "calendar_token", "");

    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(token)}'))`,
      `$c = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(cal)}'))`,
      "$timeMin = (Get-Date).ToUniversalTime().ToString('o')",
      "$uri = 'https://www.googleapis.com/calendar/v3/calendars/' + $c + '/events?maxResults=' + " +
        `${max} + '&timeMin=' + [uri]::EscapeDataString($timeMin)`,
      "$headers = @{ Authorization = 'Bearer ' + $t }",
      "$evts = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get",
      "$out = @()",
      "foreach ($e in @($evts.items)) {",
      "  $when = $e.start.dateTime; if (-not $when) { $when = $e.start.date }",
      "  $out += ('[' + $when + '] ' + $e.summary)",
      "}",
      "Write-Output ('calendar (' + $out.Count + ' upcoming events):')",
      "$out | Out-String",
    ].join("\n");

    return this.runScript(script);
  }

  async addCalendarEvent(args: {
    summary: string;
    start: string;
    end?: string;
    description?: string;
  }): Promise<string> {
    const token = this.token("calendar");
    const cal = this.calendarId();
    if (!token) return missingConfig("add_calendar_event", "calendar_token", "");

    const start = new Date(args.start);
    const startIso = Number.isNaN(start.getTime()) ? args.start : start.toISOString();
    const endIso = args.end
      ? (() => {
          const end = new Date(args.end);
          return Number.isNaN(end.getTime()) ? args.end : end.toISOString();
        })()
      : new Date(start.getTime() + 3_600_000).toISOString();

    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(token)}'))`,
      `$c = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(cal)}'))`,
      `$sum = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(args.summary)}'))`,
      `$desc = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(args.description ?? "")}'))`,
      `$s = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(startIso)}'))`,
      `$e = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(endIso)}'))`,
      "$headers = @{ Authorization = 'Bearer ' + $t; 'Content-Type' = 'application/json' }",
      "$payload = @{ summary = $sum; description = $desc; start = @{ dateTime = $s; timeZone = 'UTC' }; end = @{ dateTime = $e; timeZone = 'UTC' } } | ConvertTo-Json",
      "$uri = 'https://www.googleapis.com/calendar/v3/calendars/' + $c + '/events'",
      "$created = Invoke-RestMethod -Uri $uri -Headers $headers -Method Post -ContentType 'application/json' -Body $payload",
      'Write-Output ("created calendar event: " + $created.summary + " (id " + $created.id + ")")',
    ].join("\n");

    return this.runScript(script);
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private token(which: "gmail" | "calendar"): string {
    const cfg = this.getConfig();
    if (which === "gmail") return cfg.gmailToken ?? "";
    return cfg.calendarToken ?? cfg.gmailToken ?? "";
  }

  private calendarId(): string {
    return this.getConfig().calendarId ?? "primary";
  }

  private async runScript(script: string): Promise<string> {
    const dir = await this.scriptDirectory();
    const path = `${dir}${dir.endsWith("\\") ? "" : "\\"}integ-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.ps1`;
    await invoke<void>("write_local_file", { path, content: script });
    try {
      return await invoke<string>("execute_windows_command", {
        command: "powershell",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path],
        confirmed: false,
      });
    } catch (error) {
      return String(error);
    }
  }

  private async scriptDirectory(): Promise<string> {
    if (this.scriptDir) return this.scriptDir;
    const dir = await appDataDir();
    const sep = dir.endsWith("\\") || dir.endsWith("/") ? "" : "\\";
    this.scriptDir = `${dir}${sep}big-g-scripts`;
    return this.scriptDir;
  }
}

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function missingConfig(tool: string, key: string, hint: string): string {
  const note = hint || `Tell Big G the value (e.g. "my ${key} is ...") and it will be remembered.`;
  return `${tool}: '${key}' is not configured. ${note}`;
}