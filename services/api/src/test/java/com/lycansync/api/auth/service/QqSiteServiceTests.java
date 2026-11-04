package com.lycansync.api.auth.service;

import com.lycansync.api.auth.config.AccountAccessProperties;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 官网部署信息仅作为经过转义的公开文本，不能注入脚本或借用个人默认配置。
 *
 * @author Wreckloud
 * @since 2026-11-04
 */
class QqSiteServiceTests {
    @Test
    void unconfiguredSiteHasNoEmptyContactLinkOrTemplateMarkers() throws Exception {
        String html = new QqSiteService(new AccountAccessProperties()).index().getContentAsString(StandardCharsets.UTF_8);
        assertThat(html).contains("/qq-login.png").doesNotContain("{{SITE_", "联系维护者", "beian.miit.gov.cn");
    }

    @Test
    void siteEscapesConfigurationAndRejectsUnsafeContactUrl() throws Exception {
        var settings = new AccountAccessProperties();
        settings.setSiteIcpNumber("备案<script>");
        settings.setSiteContactUrl("https://example.com/contact?a=1&b=2");
        String html = new QqSiteService(settings).index().getContentAsString(StandardCharsets.UTF_8);
        assertThat(html).contains("备案&lt;script&gt;", "a=1&amp;b=2").doesNotContain("备案<script>");
        for (String url : new String[]{"javascript:alert(1)", "http://example.com", "https://user:password@example.com"}) {
            settings.setSiteContactUrl(url);
            assertThatThrownBy(() -> new QqSiteService(settings)).isInstanceOf(IllegalStateException.class);
        }
    }
}
