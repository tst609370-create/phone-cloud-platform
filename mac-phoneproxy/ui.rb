#!/usr/bin/ruby
# frozen_string_literal: true

require 'cgi'
require 'fileutils'
require 'json'
require 'open3'
require 'tempfile'
require 'thread'
require 'time'
require 'uri'
require 'webrick'

PORT = 8099
LAN_PREFIX = '192.168.50.'
DATA_DIR = '/Users/ct/Library/Application Support/PhoneProxy'
PROXIES_FILE = File.join(DATA_DIR, 'proxies.json')
QUALITY_FILE = File.join(DATA_DIR, 'ip-quality.json')
WIFI_FILE = File.join(DATA_DIR, 'wifi.json')
WIFI_QR_FILE = File.join(DATA_DIR, 'wifi-qr.png')
RUNTIME_DIR = '/var/run/phoneproxy'
ACCOUNTS_FILE = File.join(RUNTIME_DIR, 'accounts.json')
ASSIGNMENTS_FILE = File.join(RUNTIME_DIR, 'assignments.json')
ERROR_LOG = '/Users/ct/PhoneProxy/last-error.log'
MANAGER = '/usr/local/libexec/phoneproxy-start'
EVENT_CLIENTS = []
EVENT_LOCK = Mutex.new
AUTO_ASSIGN_LOCK = Mutex.new

def publish_update
  EVENT_LOCK.synchronize { EVENT_CLIENTS.dup }.each { |queue| queue << true }
end

def read_json(path, fallback)
  JSON.parse(File.read(path))
rescue Errno::ENOENT, Errno::EACCES, JSON::ParserError
  fallback
end

def write_proxies(proxies)
  write_private_json(PROXIES_FILE, proxies)
end

def write_private_json(path, payload)
  FileUtils.mkdir_p(DATA_DIR, mode: 0o700)
  temporary = "#{path}.#{$$}.tmp"
  File.write(temporary, JSON.generate(payload))
  File.chmod(0o600, temporary)
  File.rename(temporary, path)
end

def write_private_file(path, content)
  FileUtils.mkdir_p(DATA_DIR, mode: 0o700)
  temporary = "#{path}.#{$$}.tmp"
  File.binwrite(temporary, content)
  File.chmod(0o600, temporary)
  File.rename(temporary, path)
end

def alive?(pid)
  Process.kill(0, Integer(pid))
  true
rescue Errno::EPERM
  true
rescue StandardError
  false
end

def runtime_accounts
  read_json(ACCOUNTS_FILE, []).select { |account| alive?(account['pid']) }
end

def normalize_spec(spec)
  spec.to_s.strip.sub(/\\\z/, '').strip
end

def parse_spec(spec)
  host, port, user, password, extra = normalize_spec(spec).split('/', 5)
  raise ArgumentError, '格式应为：服务器/端口/用户名/密码' if extra || [host, port, user, password].any? { |value| value.to_s.empty? }
  raise ArgumentError, '服务器地址无效' unless host.match?(/\A[A-Za-z0-9.-]+\z/)
  raise ArgumentError, '端口无效' unless port.match?(/\A\d+\z/) && port.to_i.between?(1, 65_535)
  raise ArgumentError, '账号内容无效' if user.match?(/[\r\n]/) || password.match?(/[\r\n]/)

  [host, port, user, password]
end

def proxy_curl(host, port, user, password, url, timeout = 15)
  config = <<~CONFIG
    silent
    show-error
    fail
    connect-timeout = 8
    max-time = #{timeout}
    proxy = #{JSON.generate("socks5://#{host}:#{port}")}
    proxy-user = #{JSON.generate("#{user}:#{password}")}
    url = #{JSON.generate(url)}
  CONFIG
  Tempfile.create(['phoneproxy-check-', '.conf']) do |file|
    file.chmod(0o600)
    file.write(config)
    file.flush
    return Open3.capture3('/usr/bin/curl', '--config', file.path)
  end
end

def quality_grade(score)
  return '优' if score >= 85
  return '良' if score >= 70
  return '一般' if score >= 50

  '较差'
end

def public_json(url, timeout = 10)
  out, _err, status = Open3.capture3('/usr/bin/curl', '-fsS', '--max-time', timeout.to_s, url)
  raise 'IP 信息服务暂时不可用' unless status.success?

  JSON.parse(out)
rescue JSON::ParserError
  raise 'IP 信息返回异常'
end

def ip_profile(exit_ip, latency_ms: nil, who: nil, check: nil)
  encoded_ip = URI.encode_www_form_component(exit_ip)
  who ||= public_json("https://ipwho.is/#{encoded_ip}")
  check ||= public_json("https://proxycheck.io/v2/#{encoded_ip}?vpn=1&asn=1&risk=1")
  raise 'IP 归属地检测失败' if who['success'] == false

  risk_data = check[exit_ip].is_a?(Hash) ? check[exit_ip] : {}
  risk = risk_data['risk'].to_s.match?(/\A\d+\z/) ? risk_data['risk'].to_i.clamp(0, 100) : nil
  detected_proxy = risk_data['proxy'].to_s.downcase == 'yes'
  score = 100
  score -= [((latency_ms - 80) / 8.0).ceil, 45].min if latency_ms && latency_ms > 80
  score -= [risk / 2, 40].min if risk
  score -= 20 if detected_proxy
  score = score.clamp(0, 100)
  connection = who['connection'].is_a?(Hash) ? who['connection'] : {}

  {
    'exit_ip' => exit_ip, 'latency_ms' => latency_ms,
    'country' => who['country'].to_s, 'country_code' => who['country_code'].to_s,
    'region' => who['region'].to_s, 'city' => who['city'].to_s,
    'isp' => connection['isp'].to_s, 'asn' => connection['asn'].to_s,
    'provider' => risk_data['provider'].to_s, 'network_type' => risk_data['type'].to_s,
    'is_proxy' => detected_proxy, 'risk' => risk,
    'quality_score' => score, 'quality' => quality_grade(score), 'checked_at' => Time.now.iso8601
  }
end

def inspect_exit_ip(exit_ip)
  raise '出口 IP 无效' unless exit_ip.to_s.match?(/\A[0-9A-Fa-f:.]+\z/)

  ip_profile(exit_ip)
end

def validate_proxy(spec)
  host, port, user, password = parse_spec(spec)
  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  ip_host = host.match?(/\A(?:\d{1,3}\.){3}\d{1,3}\z/)
  out, _err, status = proxy_curl(host, port, user, password, ip_host ? 'http://www.baidu.com/' : 'https://api.ipify.org', 10)
  out = host if status.success? && ip_host
  latency_ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round
  exit_ip = out.strip
  raise 'SOCKS5 账号连接失败' unless status.success? && exit_ip.match?(/\A[0-9A-Fa-f:.]+\z/)

  encoded_ip = URI.encode_www_form_component(exit_ip)
  who = public_json("https://ipwho.is/#{encoded_ip}") rescue {}
  check_out, _check_err, check_status = Open3.capture3(
    '/usr/bin/curl', '-fsS', '--max-time', '10', "https://proxycheck.io/v2/#{encoded_ip}?vpn=1&asn=1&risk=1"
  )
  check = check_status.success? ? (JSON.parse(check_out) rescue {}) : {}
  ip_profile(exit_ip, latency_ms: latency_ms, who: who, check: check).merge(
    'spec' => spec, 'host' => host, 'port' => port
  )
end

def saved_proxies
  proxies = read_json(PROXIES_FILE, [])
  live_ids = runtime_accounts.map { |account| account['id'] }
  changed = false
  proxies.each do |proxy|
    next unless proxy['runtime_id'] && !live_ids.include?(proxy['runtime_id'])

    proxy.delete('runtime_id')
    changed = true
  end
  write_proxies(proxies) if changed
  proxies
end

def import_proxy(spec)
  spec = normalize_spec(spec)
  host, port, user, = parse_spec(spec)
  proxies = saved_proxies
  raise '这个代理账号已经导入' if proxies.any? { |proxy| proxy.values_at('host', 'port', 'user') == [host, port, user] }

  used_slots = proxies.map { |proxy| proxy['slot'].to_i }
  used_slots.concat(runtime_accounts.map { |account| account['id'].to_s[/\Ap(\d+)\z/, 1]&.to_i }.compact)
  slot = (1..12).find { |number| !used_slots.include?(number) }
  raise '最多支持 12 个代理' unless slot

  proxy = validate_proxy(spec)
  proxy.merge!('id' => "s#{slot}", 'slot' => slot, 'label' => "代理 #{slot}", 'user' => user)
  proxies << proxy
  write_proxies(proxies)
  proxy
end

def runtime_to_proxy_id(proxies)
  proxies.map { |proxy| [proxy['runtime_id'], proxy['id']] if proxy['runtime_id'] }.compact.to_h
end

def stop_unused_tunnels(proxies)
  used_runtime_ids = read_json(ASSIGNMENTS_FILE, {}).values.map { |assignment| assignment['account'] }
  managed_runtime_ids = proxies.map { |proxy| proxy['runtime_id'] }.compact
  proxies.each do |proxy|
    next unless proxy['runtime_id'] && !used_runtime_ids.include?(proxy['runtime_id'])

    call_manager('action' => 'stop', 'account' => proxy['runtime_id'])
    proxy.delete('runtime_id')
  end
  runtime_accounts.each do |account|
    next if managed_runtime_ids.include?(account['id']) || used_runtime_ids.include?(account['id'])

    call_manager('action' => 'stop', 'account' => account['id'])
  end
end

def assign_proxy_to_phone(mac, ip, proxy_id)
  proxies = saved_proxies
  runtime_id = ''
  started_runtime_id = nil
  unless proxy_id.to_s.empty?
    if proxy_id.start_with?('legacy:')
      runtime_id = proxy_id.delete_prefix('legacy:')
      raise '代理已停止，请重新导入' unless runtime_accounts.any? { |account| account['id'] == runtime_id }
    else
      proxy = proxies.find { |item| item['id'] == proxy_id }
      raise '代理不存在' unless proxy

      runtime_id = proxy['runtime_id'].to_s
      unless runtime_accounts.any? { |account| account['id'] == runtime_id }
        result = call_manager('action' => 'import', 'spec' => proxy['spec'])
        runtime_id = result.dig('account', 'id').to_s
        raise '隧道启动失败' if runtime_id.empty?

        proxy['runtime_id'] = runtime_id
        started_runtime_id = runtime_id
        write_proxies(proxies)
      end
    end
  end

  call_manager('action' => 'assign', 'mac' => mac, 'ip' => ip, 'account' => runtime_id)
  stop_unused_tunnels(proxies)
  write_proxies(proxies)
rescue StandardError
  if started_runtime_id
    call_manager('action' => 'stop', 'account' => started_runtime_id) rescue nil
    proxies&.each { |proxy| proxy.delete('runtime_id') if proxy['runtime_id'] == started_runtime_id }
    write_proxies(proxies) if proxies
  end
  raise
end

def delete_proxy(proxy_id)
  proxies = saved_proxies
  if proxy_id.start_with?('legacy:')
    runtime_id = proxy_id.delete_prefix('legacy:')
    call_manager('action' => 'stop', 'account' => runtime_id)
    return
  end

  proxy = proxies.find { |item| item['id'] == proxy_id }
  raise '代理不存在' unless proxy

  call_manager('action' => 'stop', 'account' => proxy['runtime_id']) if proxy['runtime_id']
  proxies.delete(proxy)
  write_proxies(proxies)
end

def recheck_proxy(proxy_id)
  if proxy_id.start_with?('legacy:')
    runtime_id = proxy_id.delete_prefix('legacy:')
    account = runtime_accounts.find { |item| item['id'] == runtime_id }
    raise '旧代理已经停止' unless account

    profile = inspect_exit_ip(account['exit_ip'].to_s)
    cache = read_json(QUALITY_FILE, {})
    cache[profile['exit_ip']] = profile
    write_private_json(QUALITY_FILE, cache)
    return profile
  end

  proxies = saved_proxies
  proxy = proxies.find { |item| item['id'] == proxy_id }
  raise '代理不存在' unless proxy

  proxy.merge!(validate_proxy(proxy['spec']))
  write_proxies(proxies)
  proxy
end

def wifi_settings
  read_json(WIFI_FILE, { 'ssid' => 'PhoneProxy', 'security' => 'WPA', 'hidden' => false })
end

def wifi_escape(value)
  value.to_s.gsub(/[\\;,:"]/) { |character| "\\#{character}" }
end

def wifi_payload(settings)
  security = settings['security'].to_s
  security = 'WPA' unless %w[WPA WEP nopass].include?(security)
  fields = ["T:#{security}", "S:#{wifi_escape(settings['ssid'])}"]
  fields << "P:#{wifi_escape(settings['password'])}" unless security == 'nopass'
  fields << "H:#{settings['hidden'] ? 'true' : 'false'}"
  "WIFI:#{fields.join(';')};;"
end

def wifi_qr_png(payload)
  swift = <<~'SWIFT'
    import AppKit
    import CoreImage
    import Foundation

    let env = ProcessInfo.processInfo.environment
    guard let payload = env["PHONEPROXY_WIFI_PAYLOAD"],
          let outputPath = env["PHONEPROXY_WIFI_QR_PATH"],
          let data = payload.data(using: .utf8),
          let filter = CIFilter(name: "CIQRCodeGenerator") else { exit(2) }
    filter.setValue(data, forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else { exit(3) }
    let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    let context = CIContext()
    guard let image = context.createCGImage(scaled, from: scaled.extent) else { exit(4) }
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(5) }
    try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
  SWIFT
  Tempfile.create(['phoneproxy-wifi-', '.png']) do |file|
    file.close
    env = { 'PHONEPROXY_WIFI_PAYLOAD' => payload, 'PHONEPROXY_WIFI_QR_PATH' => file.path }
    _out, err, status = Open3.capture3(env, '/usr/bin/swift', '-e', swift)
    raise("二维码生成失败：#{err.lines.last.to_s.strip}") unless status.success? && File.size?(file.path)

    return File.binread(file.path)
  end
end

def save_wifi_settings(ssid, password, security, hidden)
  raise '请输入 Wi-Fi 名称' if ssid.to_s.strip.empty?
  raise 'Wi-Fi 名称过长' if ssid.bytesize > 32

  current = wifi_settings
  security = %w[WPA WEP nopass].include?(security) ? security : 'WPA'
  password = current['password'].to_s if password.to_s.empty?
  raise '请输入 Wi-Fi 密码' if security != 'nopass' && password.empty?
  raise 'Wi-Fi 密码过长' if password.bytesize > 63

  settings = { 'ssid' => ssid.strip, 'password' => password, 'security' => security, 'hidden' => hidden }
  write_private_file(WIFI_QR_FILE, wifi_qr_png(wifi_payload(settings)))
  write_private_json(WIFI_FILE, settings)
  settings
end

def lease_devices
  data = File.read('/var/db/dhcpd_leases')
  data.scan(/\{(.*?)\}/m).map do |block|
    ip = block[/\bip_address\s*=\s*([^;\s]+)/, 1]
    next unless ip&.start_with?(LAN_PREFIX)
    mac = block[/\bhw_address\s*=\s*(?:\d+,)?([^;\s]+)/, 1].to_s.downcase
    name = block[/\bname\s*=\s*([^;\n]+)/, 1].to_s.strip.gsub(/\A["']|["']\z/, '')
    { 'ip' => ip, 'mac' => mac, 'name' => name }
  end.compact
rescue Errno::ENOENT, Errno::EACCES
  []
end

def arp_devices
  out, = Open3.capture2('/usr/sbin/arp', '-an', '-i', 'en0')
  out.lines.map do |line|
    match = line.match(/\((192\.168\.50\.\d+)\) at ([0-9a-f:]+) on en0/i)
    next unless match
    next if %w[192.168.50.1 192.168.50.254].include?(match[1])
    { 'ip' => match[1], 'mac' => match[2].downcase, 'name' => '' }
  end.compact
rescue StandardError
  []
end

def devices
  merged = {}
  lease_devices.each { |device| merged[device['ip']] = device }
  arp_devices.each do |device|
    merged[device['ip']] ||= device
    merged[device['ip']]['mac'] = device['mac']
  end
  items = merged.values.sort_by { |device| device['ip'].split('.').last.to_i }
  threads = items.map do |device|
    Thread.new do
      _out, _err, status = Open3.capture3('/sbin/ping', '-c', '1', '-W', '350', device['ip'])
      device['online'] = status.success?
      device['name'] = '未命名手机' if device['name'].to_s.empty?
    rescue StandardError
      device['online'] = false
    end
  end
  threads.each(&:join)
  items
end

def next_proxy(proxies, assignments)
  runtime_to_saved = proxies.map { |proxy| [proxy['runtime_id'], proxy['id']] if proxy['runtime_id'] }.compact.to_h
  usage = proxies.to_h { |proxy| [proxy['id'], 0] }
  assignments.each_value do |assignment|
    saved_id = runtime_to_saved[assignment['account']]
    usage[saved_id] += 1 if saved_id
  end
  proxies.min_by { |proxy| [usage[proxy['id']], proxy['slot'].to_i] }
end

def auto_assign_devices(phones)
  AUTO_ASSIGN_LOCK.synchronize do
    phones.select { |phone| phone['online'] && phone['mac'].to_s.match?(/\A(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\z/) }.each do |phone|
      assignments = read_json(ASSIGNMENTS_FILE, {})
      existing = assignments[phone['mac']]
      if existing && runtime_accounts.any? { |account| account['id'] == existing['account'] }
        call_manager('action' => 'assign', 'mac' => phone['mac'], 'ip' => phone['ip'], 'account' => existing['account']) if existing['ip'] != phone['ip']
        next
      end

      call_manager('action' => 'assign', 'mac' => phone['mac'], 'ip' => phone['ip'], 'account' => '') if existing
      attempted = []
      last_error = nil
      loop do
        candidates = saved_proxies.reject { |proxy| attempted.include?(proxy['id']) }
        proxy = next_proxy(candidates, read_json(ASSIGNMENTS_FILE, {}))
        break unless proxy

        begin
          assign_proxy_to_phone(phone['mac'], phone['ip'], proxy['id'])
          last_error = nil
          break
        rescue StandardError => e
          attempted << proxy['id']
          last_error = e
        end
      end
      record_error(last_error) if last_error
    end
  end
end

def status_payload
  phones = devices
  auto_assign_devices(phones)
  proxies = saved_proxies
  live = runtime_accounts
  mapped = runtime_to_proxy_id(proxies)
  quality_cache = read_json(QUALITY_FILE, {})
  live.each do |account|
    next if mapped.key?(account['id'])

    legacy_id = "legacy:#{account['id']}"
    mapped[account['id']] = legacy_id
    proxies << {
      'id' => legacy_id, 'runtime_id' => account['id'], 'label' => account['label'],
      'host' => '已启动的旧代理', 'port' => '', 'exit_ip' => account['exit_ip'],
      'quality' => '未检测', 'legacy' => true
    }.merge(quality_cache[account['exit_ip'].to_s] || {})
  end
  assignments = read_json(ASSIGNMENTS_FILE, {})
  public_proxies = proxies.map do |proxy|
    runtime_id = proxy['runtime_id']
    proxy.reject { |key, _value| %w[spec user].include?(key) }.merge(
      'running' => !runtime_id.nil? && live.any? { |account| account['id'] == runtime_id },
      'assigned' => assignments.count { |_mac, value| value['account'] == runtime_id }
    )
  end
  phones.each do |phone|
    runtime_id = assignments.dig(phone['mac'], 'account').to_s
    phone['account'] = mapped[runtime_id].to_s
  end
  wifi = wifi_settings
  {
    running: public_proxies.any? { |proxy| proxy['running'] }, accounts: public_proxies, devices: phones,
    wifi: { ssid: wifi['ssid'].to_s, configured: File.file?(WIFI_QR_FILE) }
  }
end

def call_manager(payload)
  out, err, status = Open3.capture3('/usr/bin/sudo', '-n', MANAGER, stdin_data: JSON.generate(payload))
  unless status.success?
    detail = [out, err].join("\n").lines.map(&:strip).reject(&:empty?).last
    raise(detail || '代理操作失败')
  end
  JSON.parse(out)
end

def record_error(error, secrets = [])
  message = error.message.to_s
  secrets.compact.reject(&:empty?).each { |secret| message = message.gsub(secret, '[已隐藏]') }
  File.open(ERROR_LOG, File::WRONLY | File::CREAT | File::TRUNC, 0o600) { |file| file.puts("#{Time.now.iso8601}\t#{error.class}\t#{message}") }
  message
rescue StandardError
  '操作失败，请检查 SOCKS5 账号和网络。'
end

def page(message = '', error: false)
  notice = message.empty? ? '' : %(<div class="notice #{error ? 'error' : 'success'}">#{CGI.escapeHTML(message)}</div>)
  <<~HTML
    <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SOCKS5 代理管理</title><style>
    :root{color-scheme:dark;--bg:#07111f;--panel:#0d1a2c;--soft:#101e31;--line:#263a55;--muted:#89a0ba;--text:#eaf3ff;--blue:#3892ff;--green:#2dcf7c;--red:#ff6f7d}*{box-sizing:border-box}html,body{min-height:100%;background:var(--bg)}body{margin:0;color:var(--text);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1060px;margin:22px auto;padding:0 18px}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;box-shadow:0 18px 50px #0005}h1{margin:0 0 5px;font-size:24px}.sub{color:var(--muted);margin:0 0 18px}
    .status{display:flex;gap:10px;align-items:center;padding:12px 14px;background:#101f33;border-radius:11px}.dot{width:9px;height:9px;border-radius:50%;background:#64748b}.dot.ok{background:#25c46b;box-shadow:0 0 0 4px #25c46b20}.status b{margin-right:auto}.muted{color:#8293aa}.panel{margin-top:18px;padding:15px;border:1px solid var(--line);border-radius:12px;background:#0a1626}label{display:block;font-weight:650;margin-bottom:8px}textarea,input,select{border:1px solid #30445f;border-radius:9px;color:#e7f0fb;background:var(--soft);outline:none}textarea:focus,input:focus,select:focus{border-color:#3b91f5;box-shadow:0 0 0 3px #3b91f525}textarea{width:100%;height:82px;resize:vertical;padding:11px 12px;font:14px ui-monospace,Menlo,monospace}.import-footer{display:flex;align-items:center;gap:12px;margin-top:9px}.help{margin:0;color:#8293aa;font-size:12px}.import button{margin-left:auto;min-width:160px}.notice{margin:14px 0 0;padding:11px 13px;border-radius:9px}.success{background:#123b2a;color:#7be3a9}.error{background:#431d25;color:#ff9da8}
    button{height:38px;padding:0 14px;border:0;border-radius:9px;color:#fff;background:#237df0;font-weight:700;cursor:pointer}button:hover{background:#3a91ff}button:disabled{opacity:.55;cursor:wait}.secondary{height:30px;padding:0 10px;background:#183b64;color:#8fc7ff}.secondary:hover{background:#215187}.danger{height:30px;padding:0 10px;background:#44232b;color:#ff9daa}.danger:hover{background:#61303a}.section{display:flex;align-items:center;margin:22px 0 9px}.section h2{font-size:17px;margin:0}.count{margin-left:7px;color:#8293aa}.refresh{margin-left:auto;color:#5fd59a;font-size:12px}
    .proxy-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:8px}.proxy{display:grid;grid-template-columns:1fr auto;gap:5px 10px;padding:13px;border:1px solid #283a52;border-radius:11px;background:var(--soft)}.proxy strong{display:flex;align-items:center;gap:7px}.proxy strong:before{content:"";width:8px;height:8px;border-radius:50%;background:#64748b}.proxy.running strong:before{background:#25c46b}.proxy small{color:#8293aa}.proxy .detail{grid-column:1/-1;line-height:1.5}.proxy .quality{color:#7ec1ff}.actions{display:flex;gap:6px;grid-row:1/3;grid-column:2;align-self:center}
    .wifi{display:grid;grid-template-columns:1fr 220px;gap:18px;align-items:center}.wifi-fields{display:grid;grid-template-columns:1fr 120px;gap:10px}.wifi-fields label{margin:0;color:#9fb0c4;font-size:12px}.wifi-fields input,.wifi-fields select{width:100%;height:38px;margin-top:6px;padding:0 10px}.wifi-fields .wide{grid-column:1/-1}.wifi-actions{display:flex;align-items:center;gap:10px;margin-top:12px}.wifi-actions .help{margin-right:auto}.qr{text-align:center}.qr img{display:block;width:190px;height:190px;margin:auto;padding:10px;border-radius:12px;background:#fff}.qr strong{display:block;margin-top:8px}.qr[hidden]{display:none}
    .devices{border:1px solid #283a52;border-radius:11px;overflow:hidden}.row{display:grid;grid-template-columns:1.25fr 110px 1fr 180px;gap:10px;align-items:center;padding:11px 13px;border-top:1px solid #1d2d42}.row:first-child{border-top:0}.head{background:var(--soft);color:#8293aa;font-size:12px}.device{font-weight:650}.pill{display:inline-flex;align-items:center;gap:6px;color:#8293aa}.pill:before{content:"";width:8px;height:8px;border-radius:50%;background:#64748b}.pill.on:before{background:#25c46b}.mono{font-family:ui-monospace,Menlo,monospace}.assignment{width:100%;height:34px;padding:0 8px}.empty{text-align:center;color:#8293aa;padding:26px 12px}
    @media(max-width:650px){main{margin:10px auto;padding:0 9px}.card{padding:15px}.import-footer{align-items:stretch;flex-direction:column}.import button{margin:0}.proxy-list{grid-template-columns:1fr}.actions{flex-direction:column}.wifi{grid-template-columns:1fr}.wifi-fields{grid-template-columns:1fr}.wifi-fields .wide{grid-column:auto}.row{grid-template-columns:1fr 125px}.head,.mac{display:none}}</style></head><body><main><div class="card">
    <h1>SOCKS5 代理管理</h1><p class="sub">先验证代理质量，再选择分配给哪台手机</p><div class="status"><span id="proxyDot" class="dot"></span><b id="proxyState">读取中…</b><span id="deviceSummary" class="muted"></span></div>#{notice}
    <form class="panel import" method="post" action="/import" autocomplete="off"><label>验证并导入 SOCKS5 代理</label><textarea name="spec" required placeholder="每行一个：服务器/端口/用户名/密码"></textarea><div class="import-footer"><p class="help">验证真实出口 IP、归属地、运营商、延迟和风险；分配手机时才启动隧道。</p><button type="submit">验证并导入</button></div></form>
    <div class="section"><h2>代理账号</h2><span id="proxyCount" class="count">(0)</span><span id="eventState" class="refresh">实时连接中…</span></div><div id="proxyList" class="proxy-list"><div class="empty">暂无代理</div></div>
    <div class="section"><h2>Wi-Fi 扫码连接</h2></div><div class="panel wifi"><form id="wifiForm"><div class="wifi-fields"><label>Wi-Fi 名称<input id="wifiSsid" name="ssid" value="PhoneProxy" required maxlength="32"></label><label>加密方式<select name="security"><option value="WPA">WPA/WPA2/WPA3</option><option value="WEP">WEP</option><option value="nopass">无密码</option></select></label><label class="wide">Wi-Fi 密码<input id="wifiPassword" name="password" type="password" maxlength="63" placeholder="首次填写；以后留空表示不修改"></label></div><div class="wifi-actions"><p class="help">保存一次，以后手机直接扫码加入网络。</p><button type="submit">保存并生成二维码</button></div></form><div id="qrBox" class="qr" hidden><img id="wifiQr" alt="Wi-Fi 连接二维码"><strong id="qrSsid"></strong><small class="muted">相机扫码即可连接</small></div></div>
    <div class="section"><h2>手机分配</h2><span id="deviceCount" class="count">(0)</span></div><div id="deviceList" class="devices"><div class="empty">连接华硕 Wi-Fi 后会自动出现并分配代理</div></div>
    </div></main><script>
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const post=(url,data)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)}).then(async r=>{if(!r.ok)throw Error(await r.text());return r.json()});let busy=false;
    async function refresh(){if(busy)return;busy=true;try{const s=await fetch('/status',{cache:'no-store'}).then(r=>r.json()),active=s.accounts.filter(a=>a.running).length;proxyDot.className='dot '+(active?'ok':'');proxyState.textContent=s.accounts.length?`已保存 ${s.accounts.length} 个 · ${active} 个使用中`:'尚未导入代理';deviceSummary.textContent=`${s.devices.filter(d=>d.online).length} 台手机在线`;proxyCount.textContent=`(${s.accounts.length})`;deviceCount.textContent=`(${s.devices.length})`;if(!wifiSsid.dataset.loaded){wifiSsid.value=s.wifi.ssid||'PhoneProxy';wifiSsid.dataset.loaded='1'}qrSsid.textContent=s.wifi.ssid||'';qrBox.hidden=!s.wifi.configured;if(s.wifi.configured&&!wifiQr.src)wifiQr.src='/wifi/qr';
    proxyList.innerHTML=s.accounts.length?s.accounts.map(a=>{const place=[a.country,a.region,a.city].filter(Boolean).join(' · ')||'未检测',risk=a.risk==null?'风险未知':`风险 ${a.risk}`,state=a.running?`使用中 · ${a.assigned} 台手机`:'已保存 · 未启动',entry=a.port?`${a.host}:${a.port}`:a.host,type=a.network_type||'未知',checked=a.checked_at?new Date(a.checked_at).toLocaleString('zh-CN'):'未检测';return `<div class="proxy ${a.running?'running':''}"><strong>${esc(a.label)}</strong><small>${esc(state)}</small><div class="actions"><button class="secondary" data-check="${esc(a.id)}">检测 IP</button><button class="danger" data-stop="${esc(a.id)}">删除</button></div><small class="detail">入口：${esc(entry)}　出口 IP：${esc(a.exit_ip||'未检测')}</small><small class="detail">IP 归属地：${esc(place)}　运营商：${esc(a.isp||a.provider||'未检测')} ${a.asn?'('+esc(a.asn)+')':''}</small><small class="detail quality">IP 质量：${esc(a.quality||'未检测')} ${esc(a.quality_score??'--')}/100　${esc(risk)}　类型：${esc(type)}　延迟：${esc(a.latency_ms??'--')}ms</small><small class="detail">检测时间：${esc(checked)}</small></div>`}).join(''):'<div class="empty">先在上方验证并导入代理账号</div>';const options=a=>'<option value="">自动分配</option>'+s.accounts.map(p=>`<option value="${esc(p.id)}" ${p.id===a?'selected':''}>${esc(p.label)} · ${esc(p.exit_ip||'未检测')} · ${esc(p.quality||'未评分')}</option>`).join('');
    deviceList.innerHTML=s.devices.length?'<div class="row head"><span>设备</span><span>IP</span><span>MAC</span><span>代理出口</span></div>'+s.devices.map(d=>`<div class="row"><span class="device"><span class="pill ${d.online?'on':''}">${esc(d.name)}</span></span><span class="mono">${esc(d.ip)}</span><span class="mono mac">${esc(d.mac)}</span><select class="assignment" data-mac="${esc(d.mac)}" data-ip="${esc(d.ip)}">${options(d.account)}</select></div>`).join(''):'<div class="empty">手机连接华硕 Wi-Fi 后会自动分配代理</div>';document.querySelectorAll('[data-check]').forEach(b=>b.onclick=async()=>{b.disabled=true;b.textContent='检测中';try{await post('/account/check',{account:b.dataset.check});await refresh()}catch(e){alert(e.message)}finally{b.disabled=false}});document.querySelectorAll('[data-stop]').forEach(b=>b.onclick=async()=>{if(!confirm('删除这个代理？已分配的手机会立即断网。'))return;await post('/account/stop',{account:b.dataset.stop});await refresh()});document.querySelectorAll('.assignment').forEach(x=>x.onchange=async()=>{x.disabled=true;try{await post('/assign',{mac:x.dataset.mac,ip:x.dataset.ip,account:x.value});await refresh()}catch(e){alert(e.message)}finally{x.disabled=false}})}catch(e){proxyState.textContent='状态读取失败'}finally{busy=false}}
    wifiForm.onsubmit=async e=>{e.preventDefault();const button=wifiForm.querySelector('button'),data=Object.fromEntries(new FormData(wifiForm));button.disabled=true;button.textContent='生成中…';try{await post('/wifi/save',data);wifiPassword.value='';wifiQr.src='/wifi/qr?t='+Date.now();await refresh()}catch(error){alert(error.message)}finally{button.disabled=false;button.textContent='保存并生成二维码'}};refresh();const events=new EventSource('/events');events.onopen=()=>eventState.textContent='实时更新';events.onerror=()=>eventState.textContent='实时重连中…';events.addEventListener('update',refresh);
    </script></body></html>
  HTML
end

def json_response(res, payload, status = 200)
  res.status = status
  res['Content-Type'] = 'application/json; charset=utf-8'
  res['Cache-Control'] = 'no-store'
  res.body = JSON.generate(payload)
end

if ENV['PHONEPROXY_UI_SELF_TEST'] == '1'
  raise unless parse_spec('proxy.example/1080/user/pass')[1] == '1080'
  raise unless parse_spec("proxy.example/1080/user/pass\\")[3] == 'pass'
  raise unless quality_grade(90) == '优' && quality_grade(40) == '较差'
  raise unless runtime_to_proxy_id([{ 'id' => 's1', 'runtime_id' => 'p2' }]) == { 'p2' => 's1' }
  raise unless next_proxy(
    [{ 'id' => 's1', 'slot' => 1, 'runtime_id' => 'p1' }, { 'id' => 's2', 'slot' => 2, 'runtime_id' => 'p2' }],
    { 'phone' => { 'account' => 'p1' } }
  )['id'] == 's2'
  profile = ip_profile(
    '1.1.1.1', latency_ms: 120,
    who: { 'success' => true, 'country' => 'Australia', 'country_code' => 'AU', 'region' => 'Queensland', 'city' => 'Brisbane', 'connection' => { 'isp' => 'Example ISP', 'asn' => 13_335 } },
    check: { '1.1.1.1' => { 'proxy' => 'yes', 'risk' => '20', 'type' => 'Business', 'provider' => 'Example' } }
  )
  raise unless profile.values_at('country_code', 'isp', 'asn', 'network_type', 'is_proxy') == ['AU', 'Example ISP', '13335', 'Business', true]
  raise unless wifi_payload('ssid' => 'A:B', 'password' => 'p;w', 'security' => 'WPA', 'hidden' => false) == 'WIFI:T:WPA;S:A\\:B;P:p\\;w;H:false;;'
  raise unless wifi_qr_png('WIFI:T:WPA;S:PhoneProxy;P:test-pass;H:false;;').start_with?("\x89PNG".b)
  _out, config_error, = proxy_curl('127.0.0.1', '9', 'test', 'test', 'https://api.ipify.org', 1)
  raise config_error if config_error.include?('error in config')
  puts 'ui self-test ok'
  exit
end

server = WEBrick::HTTPServer.new(Port: PORT, BindAddress: '127.0.0.1', Logger: WEBrick::Log.new(File::NULL), AccessLog: [])
server.mount_proc('/') { |_req, res| res['Content-Type'] = 'text/html; charset=utf-8'; res.body = page }
server.mount_proc('/status') { |_req, res| json_response(res, status_payload) }
server.mount_proc('/events') do |_req, res|
  queue = Queue.new
  EVENT_LOCK.synchronize { EVENT_CLIENTS << queue }
  res.status = 200
  res['Content-Type'] = 'text/event-stream; charset=utf-8'
  res['Cache-Control'] = 'no-cache, no-transform'
  res['X-Accel-Buffering'] = 'no'
  res.chunked = true
  res.body = proc do |output|
    begin
      output.write("retry: 2000\nevent: update\ndata: {}\n\n")
      loop do
        queue.pop
        output.write("event: update\ndata: {}\n\n")
      end
    rescue IOError, Errno::EPIPE, Errno::ECONNRESET
      nil
    ensure
      EVENT_LOCK.synchronize { EVENT_CLIENTS.delete(queue) }
    end
  end
end
server.mount_proc('/import') do |req, res|
  raise '只允许 POST' unless req.request_method == 'POST'
  specs = req.query['spec'].to_s.lines.map { |line| normalize_spec(line) }.reject(&:empty?)
  raise '请粘贴至少一个 SOCKS5 账号' if specs.empty?
  raise '一次最多导入 12 个账号' if specs.length > 12
  failures = []
  imported = 0
  specs.each_with_index do |spec, index|
    begin
      import_proxy(spec)
      imported += 1
    rescue StandardError => e
      failures << "第 #{index + 1} 行：#{e.message}"
    end
  end
  raise failures.join('；') if imported.zero?

  File.delete(ERROR_LOG) if File.exist?(ERROR_LOG)
  publish_update if imported.positive?
  res['Content-Type'] = 'text/html; charset=utf-8'
  message = "#{imported} 个代理验证通过并已保存；未分配手机前不会启动隧道。"
  message += " 失败 #{failures.length} 个：#{failures.join('；')}" if failures.any?
  res.body = page(message, error: failures.any?)
rescue StandardError => e
  res['Content-Type'] = 'text/html; charset=utf-8'
  res.body = page(record_error(e, specs || []), error: true)
end
server.mount_proc('/assign') do |req, res|
  raise '只允许 POST' unless req.request_method == 'POST'
  assign_proxy_to_phone(req.query['mac'].to_s, req.query['ip'].to_s, req.query['account'].to_s)
  publish_update
  json_response(res, ok: true)
rescue StandardError => e
  json_response(res, { ok: false, error: record_error(e) }, 400)
end
server.mount_proc('/account/stop') do |req, res|
  raise '只允许 POST' unless req.request_method == 'POST'
  delete_proxy(req.query['account'].to_s)
  publish_update
  json_response(res, ok: true)
rescue StandardError => e
  json_response(res, { ok: false, error: record_error(e) }, 400)
end
server.mount_proc('/account/check') do |req, res|
  raise '只允许 POST' unless req.request_method == 'POST'
  profile = recheck_proxy(req.query['account'].to_s)
  publish_update
  json_response(res, ok: true, profile: profile.reject { |key, _value| key == 'spec' })
rescue StandardError => e
  json_response(res, { ok: false, error: record_error(e) }, 400)
end
server.mount_proc('/wifi/save') do |req, res|
  raise '只允许 POST' unless req.request_method == 'POST'
  settings = save_wifi_settings(
    req.query['ssid'].to_s, req.query['password'].to_s, req.query['security'].to_s,
    req.query['hidden'].to_s == '1'
  )
  publish_update
  json_response(res, ok: true, ssid: settings['ssid'])
rescue StandardError => e
  json_response(res, { ok: false, error: record_error(e, [req.query['password'].to_s]) }, 400)
end
server.mount_proc('/wifi/qr') do |_req, res|
  unless File.file?(WIFI_QR_FILE)
    res.status = 404
    res['Content-Type'] = 'text/plain; charset=utf-8'
    res.body = '请先保存 Wi-Fi 信息'
    next
  end
  res['Content-Type'] = 'image/png'
  res['Cache-Control'] = 'no-store'
  res.body = File.binread(WIFI_QR_FILE)
end
server.mount_proc('/diagnostics') do |_req, res|
  res['Content-Type'] = 'text/plain; charset=utf-8'
  res.body = File.read(ERROR_LOG)
rescue Errno::ENOENT
  res.body = '暂无错误'
end
trap('INT') { server.shutdown }
trap('TERM') { server.shutdown }
server.start
