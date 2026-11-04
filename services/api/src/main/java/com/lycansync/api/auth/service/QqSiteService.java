package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.AccountAccessProperties;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;
import org.springframework.web.util.HtmlUtils;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;

/**
 * 将部署者公开的备案与联系信息填入官网，不将个人配置写入通用源码。
 *
 * @author Wreckloud
 * @since 2026-11-04
 */
@Service
public class QqSiteService {
    private final Resource index;

    public QqSiteService(AccountAccessProperties settings) throws IOException {
        String contact = settings.getSiteContactUrl();
        if (!contact.isBlank()) {
            URI url = URI.create(contact);
            if (!"https".equals(url.getScheme()) || url.getHost() == null || url.getUserInfo() != null) {
                throw new IllegalStateException("官网联系地址必须是无凭据的 HTTPS 地址");
            }
        }
        String html = new ClassPathResource("qq-site/index.html").getContentAsString(StandardCharsets.UTF_8);
        html = html.replace("{{SITE_CONTACT}}", contact.isBlank() ? ""
                : "<a href=\"" + HtmlUtils.htmlEscape(contact) + "\">联系维护者</a>");
        html = html.replace("{{SITE_ICP}}", settings.getSiteIcpNumber().isBlank() ? ""
                : "<a href=\"https://beian.miit.gov.cn/\" rel=\"noreferrer\">"
                + HtmlUtils.htmlEscape(settings.getSiteIcpNumber()) + "</a>");
        index = new ByteArrayResource(html.getBytes(StandardCharsets.UTF_8));
    }

    public Resource index() { return index; }
}
