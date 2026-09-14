package urltest

import (
	"context"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	M "github.com/sagernet/sing/common/metadata"
	"github.com/sagernet/sing/service"
)

// Redirect only the socket in this fixture, so HTTP Host/path and the requested
// destination still expose an unexpected protocol or fallback URL.
type jBoxHTTPDialer struct {
	address     string
	mu          sync.Mutex
	destination M.Socksaddr
}

func (d *jBoxHTTPDialer) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
	d.mu.Lock()
	d.destination = destination
	d.mu.Unlock()
	return (&net.Dialer{}).DialContext(ctx, network, d.address)
}

func (*jBoxHTTPDialer) ListenPacket(context.Context, M.Socksaddr) (net.PacketConn, error) {
	return nil, errors.New("unexpected UDP probe")
}

type jBoxHTTPCertificates struct {
	adapter.CertificateStore
	pool *x509.CertPool
}

func (c jBoxHTTPCertificates) Pool() *x509.CertPool { return c.pool }

func TestJBoxHTTPProbe(t *testing.T) {
	for _, secure := range []bool{false, true} {
		t.Run(map[bool]string{false: "HTTP", true: "HTTPS"}[secure], func(t *testing.T) {
			requests := make(chan *http.Request, 1)
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests <- r
				w.WriteHeader(http.StatusNoContent)
			})
			var server *httptest.Server
			ctx := context.Background()
			if secure {
				server = httptest.NewTLSServer(handler)
				pool := x509.NewCertPool()
				pool.AddCert(server.Certificate())
				ctx = service.ContextWith[adapter.CertificateStore](ctx, jBoxHTTPCertificates{pool: pool})
			} else {
				server = httptest.NewServer(handler)
			}
			defer server.Close()
			dialer := &jBoxHTTPDialer{address: server.Listener.Addr().String()}
			delay, err := URLTest(ctx, server.URL+"/custom-204?source=clash", dialer)
			if err != nil || delay == 0 {
				t.Fatalf("successful probe: delay=%d err=%v", delay, err)
			}
			request := <-requests
			if request.Method != http.MethodHead || request.URL.RequestURI() != "/custom-204?source=clash" {
				t.Fatalf("unexpected request: %s %s", request.Method, request.URL)
			}
		})
	}
}

func TestJBoxHTTPDefaultAndRedirect(t *testing.T) {
	requests := make(chan *http.Request, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r
		w.Header().Set("Location", "https://must-not-follow.invalid/")
		w.WriteHeader(http.StatusFound)
	}))
	defer server.Close()
	dialer := &jBoxHTTPDialer{address: server.Listener.Addr().String()}
	delay, err := URLTest(context.Background(), "", dialer)
	if err != nil || delay == 0 {
		t.Fatalf("default HTTP probe: delay=%d err=%v", delay, err)
	}
	request := <-requests
	if request.Host != "www.gstatic.com" || request.URL.Path != "/generate_204" || dialer.destination.Port != 80 {
		t.Fatalf("wrong default: host=%s path=%s destination=%s", request.Host, request.URL.Path, dialer.destination)
	}
	if len(requests) != 0 {
		t.Fatal("probe followed redirect")
	}
}

func TestJBoxHTTPTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	delay, err := URLTest(ctx, server.URL, &jBoxHTTPDialer{address: server.Listener.Addr().String()})
	if err == nil || delay != 0 {
		t.Fatalf("timeout: delay=%d err=%v", delay, err)
	}
}

// J-Box:403/451/511 是「被明确拒绝」(地区封锁 / 法律屏蔽 / 门户认证),必须判失败。
// 否则按地区封锁的 OpenAI 回 403 也会被当成「可用」,AI 分组就会选中打不开 OpenAI 的节点。
func TestJBoxHTTPRejectedStatusIsFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	dialer := &jBoxHTTPDialer{address: server.Listener.Addr().String()}
	if delay, err := URLTest(context.Background(), server.URL, dialer); err == nil || delay != 0 {
		t.Fatalf("403 must be a failure: delay=%d err=%v", delay, err)
	}
}

// 401(缺 API key)说明服务确实应答了,必须仍算可达——OpenAI 的健康节点回的就是 401。
func TestJBoxHTTPAuthChallengeIsReachable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	dialer := &jBoxHTTPDialer{address: server.Listener.Addr().String()}
	if delay, err := URLTest(context.Background(), server.URL, dialer); err != nil || delay == 0 {
		t.Fatalf("401 must stay reachable: delay=%d err=%v", delay, err)
	}
}
