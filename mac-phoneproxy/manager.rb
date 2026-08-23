#!/usr/bin/ruby
# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'open3'
require 'tempfile'
require 'time'

STATE_DIR = '/var/run/phoneproxy'
ACCOUNTS_FILE = File.join(STATE_DIR, 'accounts.json')
ASSIGNMENTS_FILE = File.join(STATE_DIR, 'assignments.json')
PF_ANCHOR = '/etc/pf.anchors/phoneproxy'
HEV = '/usr/local/sbin/hev-socks5-tunnel'
LAN = '192.168.50.0/24'
MAX_ACCOUNTS = 12

def read_json(path, fallback)
  JSON.parse(File.read(path))
rescue Errno::ENOENT, JSON::ParserError
  fallback
end

def write_json(path, value)
  temporary = "#{path}.#{$$}.tmp"
  File.write(temporary, JSON.generate(value))
  File.chmod(0o644, temporary)
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

def live_accounts
  accounts = read_json(ACCOUNTS_FILE, [])
  live = accounts.select { |account| alive?(account['pid']) }
  write_json(ACCOUNTS_FILE, live) if live.length != accounts.length
  live
end

def parse_spec(spec)
  host, port, user, password, extra = spec.to_s.strip.split('/', 5)
  raise ArgumentError, '格式应为：服务器/端口/用户名/密码' if extra || [host, port, user, password].any? { |value| value.to_s.empty? }
  raise ArgumentError, '服务器地址无效' unless host.match?(/\A[A-Za-z0-9.-]+\z/)
  raise ArgumentError, '端口无效' unless port.match?(/\A\d+\z/) && port.to_i.between?(1, 65_535)
  raise ArgumentError, '账号内容无效' if user.match?(/[\r\n]/) || password.match?(/[\r\n]/)

  [host, port, user, password]
end

def yaml_quote(value)
  value.gsub("'", "''")
end

def rules_for(accounts, assignments)
  interfaces = accounts.to_h { |account| [account['id'], account['interface']] }
  rules = [
    'pass quick on lo0 all',
    "pass in quick on en0 inet from #{LAN} to #{LAN} keep state"
  ]
  assignments.each_value do |assignment|
    interface = interfaces[assignment['account']]
    next unless interface

    rules << "pass in quick on en0 route-to #{interface} inet proto { tcp, udp, icmp } from #{assignment['ip']} to any keep state"
  end
  rules << "block drop in quick on en0 inet from #{LAN} to any"
  rules << "block drop out quick on en1 inet from #{LAN} to any"
  rules.join("\n") + "\n"
end

def rebuild_pf(accounts, assignments)
  File.write(PF_ANCHOR, rules_for(accounts, assignments))
  system('/usr/sbin/sysctl', '-w', 'net.inet.ip.forwarding=1', out: File::NULL) || raise('无法开启网络转发')
  system('/usr/sbin/sysctl', '-w', 'net.inet.tcp.tso=0', out: File::NULL) || raise('无法设置网络转发')
  system('/sbin/pfctl', '-a', 'com.apple/phoneproxy', '-f', PF_ANCHOR, out: File::NULL) || raise('PF 分流规则加载失败')
  system('/sbin/pfctl', '-E', out: File::NULL, err: File::NULL)
  assignments.each_value { |assignment| system('/sbin/pfctl', '-k', assignment['ip'], out: File::NULL, err: File::NULL) }
end

def import_account(spec)
  host, port, user, password = parse_spec(spec)
  ip_host = host.match?(/\A(?:\d{1,3}\.){3}\d{1,3}\z/)
  out, status = Open3.capture2e(
    '/usr/bin/curl', '-fsS', '--max-time', '10', '--socks5', "#{host}:#{port}",
    '--proxy-user', "#{user}:#{password}", ip_host ? 'http://www.baidu.com/' : 'https://api.ipify.org'
  )
  out = host if status.success? && ip_host
  exit_ip = out.strip
  raise 'SOCKS5 账号连接失败' unless status.success? && exit_ip.match?(/\A[0-9A-Fa-f:.]+\z/)

  accounts = live_accounts
  if accounts.empty?
    system('/usr/bin/pkill', '-TERM', '-f', HEV, out: File::NULL, err: File::NULL)
    sleep 0.4
  end
  used_slots = accounts.map { |account| account['slot'].to_i }
  slot = (1..MAX_ACCOUNTS).find { |number| !used_slots.include?(number) }
  raise "最多支持 #{MAX_ACCOUNTS} 个代理" unless slot

  id = "p#{slot}"
  interface = "utun#{900 + slot}"
  config = <<~YAML
    tunnel:
      name: #{interface}
      mtu: 8500
      multi-queue: false
      ipv4: 198.18.#{slot}.1
    socks5:
      address: '#{yaml_quote(host)}'
      port: #{port}
      udp: 'udp'
      username: '#{yaml_quote(user)}'
      password: '#{yaml_quote(password)}'
    misc:
      log-file: stderr
      log-level: warn
      task-stack-size: 24576
      tcp-buffer-size: 16384
      connect-timeout: 10000
      tcp-read-write-timeout: 600000
      udp-read-write-timeout: 600000
  YAML

  pid = nil
  Tempfile.create(['phoneproxy-', '.yml']) do |file|
    file.chmod(0o600)
    file.write(config)
    file.flush
    log = File.open("/var/log/phoneproxy-hev-#{id}.log", File::WRONLY | File::CREAT | File::APPEND, 0o600)
    pid = Process.spawn(HEV, file.path, out: log, err: log)
    log.close
    Process.detach(pid)
    sleep 1.2
    unless alive?(pid) && system('/sbin/ifconfig', interface, out: File::NULL, err: File::NULL)
      Process.kill('TERM', pid) if alive?(pid)
      raise '代理隧道启动失败'
    end
  end

  account = {
    'id' => id, 'slot' => slot, 'label' => "代理 #{slot}", 'exit_ip' => exit_ip,
    'pid' => pid, 'interface' => interface, 'started_at' => Time.now.iso8601
  }
  accounts << account
  write_json(ACCOUNTS_FILE, accounts)
  rebuild_pf(accounts, read_json(ASSIGNMENTS_FILE, {}))
  account
end

def assign_phone(payload)
  mac = payload['mac'].to_s.downcase
  ip = payload['ip'].to_s
  account_id = payload['account'].to_s
  raise ArgumentError, '手机 MAC 无效' unless mac.match?(/\A(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\z/)
  raise ArgumentError, '手机 IP 无效' unless ip.match?(/\A192\.168\.50\.(?:[1-9]|\d{2}|1\d{2}|2[0-4]\d|25[0-4])\z/)

  accounts = live_accounts
  raise ArgumentError, '代理不存在或已停止' unless account_id.empty? || accounts.any? { |account| account['id'] == account_id }

  assignments = read_json(ASSIGNMENTS_FILE, {})
  account_id.empty? ? assignments.delete(mac) : assignments[mac] = { 'ip' => ip, 'account' => account_id }
  write_json(ASSIGNMENTS_FILE, assignments)
  rebuild_pf(accounts, assignments)
end

def stop_account(account_id)
  accounts = live_accounts
  account = accounts.find { |item| item['id'] == account_id }
  raise ArgumentError, '代理不存在' unless account

  Process.kill('TERM', account['pid']) if alive?(account['pid'])
  accounts.delete(account)
  assignments = read_json(ASSIGNMENTS_FILE, {})
  assignments.delete_if { |_mac, assignment| assignment['account'] == account_id }
  write_json(ACCOUNTS_FILE, accounts)
  write_json(ASSIGNMENTS_FILE, assignments)
  rebuild_pf(accounts, assignments)
end

if ENV['PHONEPROXY_SELF_TEST'] == '1'
  raise unless parse_spec('proxy.example/1080/user/pass')[1] == '1080'
  sample = rules_for([{ 'id' => 'p1', 'interface' => 'utun901' }], { 'aa' => { 'ip' => '192.168.50.8', 'account' => 'p1' } })
  raise unless sample.include?('route-to utun901') && sample.include?('block drop in quick')
  puts 'self-test ok'
  exit
end

begin
  FileUtils.mkdir_p(STATE_DIR, mode: 0o755)
  payload = JSON.parse($stdin.read)
  case payload['action']
  when 'import'
    result = { 'ok' => true, 'account' => import_account(payload['spec']) }
  when 'assign'
    assign_phone(payload)
    result = { 'ok' => true }
  when 'stop'
    stop_account(payload['account'].to_s)
    result = { 'ok' => true }
  else
    raise ArgumentError, '未知操作'
  end
  puts JSON.generate(result)
rescue StandardError => e
  warn e.message
  exit 1
end
