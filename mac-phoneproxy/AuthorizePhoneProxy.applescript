use scripting additions

on run
	display dialog "PhoneProxy 需要一次系统授权。完成后，导入和更换 SOCKS5 将不再要求管理员密码。" buttons {"取消", "开始授权"} default button "开始授权" with title "PhoneProxy 首次设置"
	set installCommand to "/bin/mkdir -p /etc/sudoers.d; /usr/bin/printf '%s\\n' 'ct ALL=(root) NOPASSWD: /usr/local/libexec/phoneproxy-start' > /etc/sudoers.d/phoneproxy; /bin/chmod 440 /etc/sudoers.d/phoneproxy; /usr/sbin/visudo -cf /etc/sudoers.d/phoneproxy >/dev/null"
	try
		do shell script installCommand with administrator privileges
		display dialog "授权完成。PhoneProxy 以后不再要求管理员密码。" buttons {"完成"} default button "完成" with icon note with title "PhoneProxy"
	on error errorMessage number errorNumber
		if errorNumber is not -128 then display dialog "授权未完成：" & errorMessage buttons {"确定"} default button "确定" with icon stop with title "PhoneProxy"
	end try
end run
