// The bookkeeping the customer has to implement INSIDE the container.
package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"
)

type process struct {
	mu       sync.Mutex
	cmd      *exec.Cmd
	exitCode *int // nil until Wait has reaped the child
}

type supervisor struct {
	mu        sync.Mutex
	processes map[string]*process
}

func reply(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func (s *supervisor) start(w http.ResponseWriter, r *http.Request) {
	// One fixed command keeps the example about ownership and reattachment.
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	id := rand.Text() // application ID, not a Linux PID that may be reused
	p := &process{cmd: cmd}
	s.mu.Lock()
	s.processes[id] = p // THIS map outlives the Worker request and its RPC stub.
	s.mu.Unlock()
	go func() {
		_ = cmd.Wait() // reap the child and retain its exit status for later calls
		code := cmd.ProcessState.ExitCode()
		p.mu.Lock()
		p.exitCode = &code
		p.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	reply(w, map[string]string{"id": id})
}

func (s *supervisor) find(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	p := s.processes[r.PathValue("id")]
	s.mu.Unlock()
	if p == nil {
		http.Error(w, "Process not found (or supervisor restarted)", 404)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if r.Method == "DELETE" {
		signaled := false
		if p.exitCode == nil {
			err := p.cmd.Process.Kill()
			if err != nil && !errors.Is(err, os.ErrProcessDone) {
				http.Error(w, err.Error(), 500)
				return
			}
			signaled = err == nil
		}
		reply(w, map[string]bool{"signaled": signaled})
		return
	}
	reply(w, map[string]any{
		"pid": p.cmd.Process.Pid, "running": p.exitCode == nil, "exitCode": p.exitCode,
	})
}

func (s *supervisor) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { reply(w, true) })
	mux.HandleFunc("POST /processes", s.start)
	mux.HandleFunc("GET /processes/{id}", s.find)
	mux.HandleFunc("DELETE /processes/{id}", s.find)
	return mux
}

func main() {
	s := &supervisor{processes: make(map[string]*process)}
	log.Fatal(http.ListenAndServe(":8080", s.handler()))
}
