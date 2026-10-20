# frozen_string_literal: true

# Run recorder for `investigation run` - the Ruby twin of recorder.cjs and
# recorder.py.
#
# archd launches the command with this directory on RUBYLIB and
# RUBYOPT=-rambio_recorder (a path in RUBYOPT breaks on spaces, such as
# C:\Program Files). Ruby requires it before any user code; Bundler keeps both
# variables, so `bundle exec rspec` records too. Without AMBIO_EVIDENCE_DIR it
# does nothing.
#
# Mechanism: TracePoint on :call, :return and :raise - built into every Ruby
# since 2.0, so there is nothing to install and no debugger. An exception in
# flight marks every method it unwinds as having raised; on Ruby 3.3+ the
# :rescue event ends it exactly where it is handled. Older Rubies have no such
# event: there a method that rescues and then returns nil without calling
# anything looks raised. On every version a method call or a non-nil return
# also ends it. Methods defined
# outside the workspace (gems, the standard library) are ignored after one
# cached path check. Blocks are not tracked; methods are what the index knows.
#
# At exit it writes one JSON document per process, in the shape the Node and
# Python recorders write, so archd analyses all three the same way: call counts
# and caller -> callee edges for workspace methods; for watched methods, call
# samples, per-path value statistics, argument mutations, arguments shared by
# identity across calls, repeated identical calls, returns and exceptions.

require 'json'

module AmbioRecorder
  # TracePoint's :rescue event arrived in Ruby 3.3.
  RESCUE_EVENT = begin
    TracePoint.new(:rescue) {}
    true
  rescue ArgumentError
    false
  end
  SAMPLE_HEAD = 6
  SAMPLE_TAIL = 4
  MAX_EDGES = 5000
  MAX_FUNCTIONS = 20_000
  FLATTEN_DEPTH = 4
  FLATTEN_LEAVES = 160
  SERIES_KEEP = 12
  DISTINCT_KEEP = 24
  PREVIEW_MAX = 240
  MUTATION_EXAMPLES = 6
  MAX_EXCEPTIONS = 20
  EXCLUDE_PARTS = %w[vendor .bundle gems node_modules .git tmp].freeze

  module_function

  # ── values ───────────────────────────────────────────────────────────────

  # [kind, value] for a leaf, or nil for something with structure.
  def leaf(v)
    case v
    when nil then ['null', nil]
    when true, false then ['boolean', v]
    when Integer then ['number', v]
    when Float then v.nan? || v.infinite? ? ['special', v.to_s] : ['number', v]
    when String then ['string', v.length <= 120 ? v : "#{v[0, 119]}…"]
    when Symbol then ['symbol', ":#{v}"]
    when Regexp then ['regexp', v.inspect[0, 100]]
    when Proc, Method then ['function', "<#{v.class.name.downcase}>"]
    else
      return ['number', v.to_f] if defined?(BigDecimal) && v.is_a?(BigDecimal)
      nil
    end
  end

  def display(l)
    return '(absent)' if l.nil?
    kind, v = l
    case kind
    when 'string' then JSON.generate(v)
    when 'null' then 'nil'
    when 'boolean' then v ? 'true' : 'false'
    else v.to_s
    end
  end

  # An object's own state, without calling any of its methods.
  def ivars(v)
    v.instance_variables.first(24).map { |name| [name.to_s.sub(/\A@/, ''), v.instance_variable_get(name)] }
  rescue StandardError
    []
  end

  def struct_pairs(v)
    v.each_pair.first(24).map { |k, x| [k.to_s, x] }
  rescue StandardError
    []
  end

  def flatten(root, prefix)
    out = {}
    seen = {}
    walk = lambda do |v, path, depth|
      return if out.size >= FLATTEN_LEAVES
      l = leaf(v)
      if l
        out[path] = l
        return
      end
      if seen[v.object_id]
        out[path] = ['ref', '<circular>']
        return
      end
      if depth >= FLATTEN_DEPTH
        out[path] = ['object', "<#{v.class.name}>"]
        return
      end
      seen[v.object_id] = true
      begin
        join = ->(k) { path.empty? ? k.to_s[0, 40] : "#{path}.#{k.to_s[0, 40]}" }
        if v.is_a?(Hash)
          if v.empty?
            out[path] = ['object', '{}']
          else
            v.each_with_index { |(k, x), i| break if i >= 24; walk.call(x, join.call(k), depth + 1) }
          end
        elsif v.is_a?(Array)
          out["#{path}.length"] = ['number', v.length]
          v.first(8).each_with_index { |x, i| walk.call(x, "#{path}[#{i}]", depth + 1) }
        elsif defined?(Set) && v.is_a?(Set)
          out["#{path}.size"] = ['number', v.size]
        else
          pairs = v.is_a?(Struct) ? struct_pairs(v) : ivars(v)
          if pairs.empty?
            out[path] = ['object', "<#{v.class.name}>"]
          else
            pairs.each { |k, x| walk.call(x, join.call(k), depth + 1) }
          end
        end
      ensure
        seen.delete(v.object_id)
      end
    end
    begin
      walk.call(root, prefix, 0)
    rescue StandardError
      nil
    end
    out
  end

  # Bounded rendering that never calls a user #inspect or #to_s.
  def preview(v, depth = 0)
    s = begin
      preview_inner(v, depth)
    rescue StandardError
      "<#{v.class.name}>"
    end
    s.length <= PREVIEW_MAX ? s : "#{s[0, PREVIEW_MAX - 1]}…"
  end

  def preview_inner(v, depth)
    l = leaf(v)
    return display(l) if l
    return "<#{v.class.name}>" if depth >= 3
    if v.is_a?(Hash)
      body = v.first(8).map { |k, x| "#{k.is_a?(Symbol) ? "#{k}:" : "#{preview_inner(k, depth + 1)} =>"} #{preview_inner(x, depth + 1)}" }
      return "{#{body.join(', ')}#{v.size > 8 ? ', …' : ''}}"
    end
    if v.is_a?(Array)
      body = v.first(8).map { |x| preview_inner(x, depth + 1) }
      return "[#{body.join(', ')}#{v.size > 8 ? ', …' : ''}]"
    end
    pairs = v.is_a?(Struct) ? struct_pairs(v) : ivars(v)
    "#{v.class.name}(#{pairs.first(8).map { |k, x| "#{k}=#{preview_inner(x, depth + 1)}" }.join(', ')})"
  end

  def outcome_shape(returned)
    return 'none' if returned.nil? || returned == 'nil'
    case returned[0]
    when '{' then 'hash'
    when '[' then 'array'
    when '"' then 'string'
    else
      return "bool:#{returned}" if %w[true false].include?(returned)
      return 'number' if returned =~ /\A-?\d+(\.\d+)?\z/
      "object:#{returned.split('(').first[0, 40]}"
    end
  end

  MAX_NODES = 60
  NODE_DEPTH = 5
  NODE_FIELDS = 48

  # Objects reachable from a value, each with its own leaf fields, so a later
  # call can recognise the same object by identity and see what changed.
  def collect_nodes(root, prefix, nodes)
    seen = {}
    walk = lambda do |v, path, depth|
      return if nodes.size >= MAX_NODES || depth > NODE_DEPTH || leaf(v) || seen[v.object_id]
      seen[v.object_id] = true
      fields = {}
      children = []
      pairs = if v.is_a?(Hash)
                v.first(NODE_FIELDS).map { |k, x| [k.to_s, x] }
              elsif v.is_a?(Array)
                fields['len'] = v.length.to_s
                v.first(8).each_with_index.map { |x, i| ["[#{i}]", x] }
              elsif v.is_a?(Struct)
                struct_pairs(v)
              else
                ivars(v).first(NODE_FIELDS)
              end
      pairs.each do |k, child|
        l = leaf(child)
        if l
          fields[k] = display(l)
        elsif !child.nil?
          children << [k.start_with?('[') ? "#{path}#{k}" : "#{path}.#{k}", child]
        end
      end
      nodes << [v, path, fields] unless fields.empty?
      children.each { |cp, c| walk.call(c, cp, depth + 1) }
    end
    walk.call(root, prefix, 0)
  rescue StandardError
    nil
  end

  # ── per-path statistics (mirrors PathStats in recorder.py) ──────────────────

  class PathStats
    def initialize
      @count = 0
      @kind = nil
      @first = nil
      @last = nil
      @min = nil
      @max = nil
      @non_dec = true
      @non_inc = true
      @changes = 0
      @series = []
      @tail = []
      @distinct = {}
      @overflow = false
      @last_num = nil
    end

    def add(l)
      @count += 1
      d = AmbioRecorder.display(l)
      k = l ? l[0] : 'absent'
      if @kind.nil?
        @kind = k
      elsif @kind != k && @kind != 'mixed'
        @kind = 'mixed'
      end
      @changes += 1 if @count > 1 && d != @last
      if l && l[0] == 'number' && l[1].is_a?(Numeric)
        n = l[1]
        if @count > 1 && @last_num
          @non_dec = false if n < @last_num
          @non_inc = false if n > @last_num
        end
        @last_num = n
        @min = @min.nil? ? n : [@min, n].min
        @max = @max.nil? ? n : [@max, n].max
      end
      @first = d if @first.nil?
      @last = d
      @series << d if @series.size < SERIES_KEEP
      @tail << d
      @tail.shift if @tail.size > 3
      if @distinct.key?(d)
        @distinct[d] += 1
      elsif @distinct.size < DISTINCT_KEEP
        @distinct[d] = 1
      else
        @overflow = true
      end
    end

    def to_h
      numeric = @kind == 'number'
      trend = if numeric && @changes.positive?
                @non_dec ? 'increasing' : @non_inc ? 'decreasing' : 'varying'
              else
                @changes.positive? ? 'varying' : 'constant'
              end
      doc = {
        'kind' => @kind, 'count' => @count, 'changes' => @changes,
        'distinct' => @overflow ? "#{DISTINCT_KEEP}+" : @distinct.size,
        'first' => @first, 'last' => @last, 'trend' => trend, 'series' => @series
      }
      if numeric
        doc['min'] = @min
        doc['max'] = @max
      end
      doc['tail'] = @tail if @count > SERIES_KEEP
      if @distinct.size <= 8 && !@overflow
        doc['top'] = @distinct.sort_by { |_, n| -n }.map { |k, n| { 'value' => k, 'n' => n } }
      end
      doc
    end
  end

  class WatchRecord
    attr_accessor :calls, :errors, :total_ms
    attr_reader :returns, :exceptions, :mutations

    def initialize(file, symbol, line)
      @file = file
      @symbol = symbol
      @line = line
      @calls = 0
      @errors = 0
      @total_ms = 0.0
      @head = []
      @tail = []
      @novel = []
      @shapes = {}
      @paths = {}
      @mutations = {}
      @exceptions = {}
      @returns = PathStats.new
      @seen_objects = {}
      @shared = {}
      @last_args = nil
      @repeats = 0
      @repeat_example = nil
      @objects = {} # object_id -> [object, path, call, fields]; objects kept alive for the run
      @drift = {}
    end

    # The same object reachable from the arguments, with different contents
    # on a later call: state shared between calls and changed by someone else.
    def check_drift(nodes, call)
      nodes.each do |obj, path, fields|
        prev = @objects[obj.object_id]
        if prev && prev[0].equal?(obj) && prev[2] != call
          changes = (prev[3].keys | fields.keys).map do |k|
            a = prev[3].fetch(k, '(absent)')
            b = fields.fetch(k, '(absent)')
            { 'key' => k, 'before' => a, 'after' => b } if a != b
          end.compact
          unless changes.empty?
            d = @drift[path]
            d = @drift[path] = { 'calls' => 0, 'examples' => [] } if d.nil? && @drift.size < 20
            if d
              d['calls'] += 1
              d['examples'] << { 'fromCall' => prev[2], 'toCall' => call, 'changes' => changes.first(4) } if d['examples'].size < 4
            end
          end
        end
        @objects[obj.object_id] = [obj, path, call, fields]
      end
    end

    def observe(path, l)
      st = @paths[path]
      if st.nil?
        return if @paths.size >= 400
        st = @paths[path] = PathStats.new
      end
      st.add(l)
    end

    def observe_args(call, names, values, fingerprint, args_preview)
      names.zip(values).each do |name, v|
        next if AmbioRecorder.leaf(v)
        known = @seen_objects[v.object_id]
        # Keep the object alive for the run so an id always means one object.
        if known.nil? || !known[0].equal?(v)
          @seen_objects[v.object_id] = [v, call]
        else
          st = (@shared[name] ||= { 'param' => name, 'calls' => 0, 'firstCall' => known[1] })
          st['calls'] += 1
        end
      end
      if @last_args && fingerprint == @last_args && !names.empty?
        @repeats += 1
        @repeat_example ||= { 'call' => call, 'args' => args_preview }
      end
      @last_args = fingerprint
    end

    def mutation(path, before, after, call)
      m = @mutations[path]
      if m.nil?
        return if @mutations.size >= 40
        m = @mutations[path] = { 'calls' => 0, 'examples' => [] }
      end
      m['calls'] += 1
      m['examples'] << { 'call' => call, 'before' => before, 'after' => after } if m['examples'].size < MUTATION_EXAMPLES
    end

    # First example of each kind of outcome, wherever it happens: rare
    # outcomes are usually the interesting ones.
    def sample(s)
      shape = s['threw'] ? "threw:#{s['threw'].split(':').first}" : AmbioRecorder.outcome_shape(s['returned'])
      known = @shapes.key?(shape)
      @shapes[shape] = true if !known && @shapes.size < 8
      if @head.size < SAMPLE_HEAD
        @head << s
      elsif !known && @novel.size < 6
        @novel << s
      else
        @tail << s
        @tail.shift if @tail.size > SAMPLE_TAIL
      end
    end

    def to_h
      {
        'file' => @file, 'symbol' => @symbol, 'line' => @line,
        'calls' => @calls, 'errors' => @errors,
        'avgMs' => @calls.positive? ? (@total_ms / @calls).round(3) : 0,
        'samples' => (@head + @novel + @tail).sort_by { |x| x['call'] },
        'values' => @paths.transform_values(&:to_h),
        'mutations' => @mutations.map { |p, m| { 'path' => p, 'calls' => m['calls'], 'examples' => m['examples'] } },
        'exceptions' => @exceptions.map { |w, n| { 'what' => w, 'n' => n } },
        'returns' => @returns.to_h,
        'shared' => @shared.values,
        'repeats' => @repeats,
        'repeatExample' => @repeat_example,
        'drift' => @drift.map { |p, d| { 'path' => p, 'calls' => d['calls'], 'examples' => d['examples'] } }
      }
    end
  end

  # ── the recorder ─────────────────────────────────────────────────────────

  class Recorder
    def initialize(dir, run_id, root, watches)
      @dir = dir
      @run_id = run_id
      @root = root && !root.empty? ? canonical(root) : nil
      @started = (Time.now.to_f * 1000).to_i
      @functions = {} # key -> [file, name, line, calls, errors, ms]
      @edges = {}
      @edges_dropped = 0
      @watch_specs = Hash.new { |h, k| h[k] = [] }
      @watched = {}
      @uncaught = []
      @in_workspace = {}
      @lock = Mutex.new
      @last_written = -1
      @cwd = Dir.pwd
      watches.each do |w|
        path = w['absPath'] || w['file']
        next if path.nil? || path.empty?
        @watch_specs[canonical(path)] << {
          symbol: w['symbol'] || '*', line_start: w['lineStart'].to_i, line_end: w['lineEnd'].to_i
        }
      end
    end

    def canonical(path)
      File.realpath(path)
    rescue StandardError
      File.expand_path(path)
    end

    def workspace?(path)
      hit = @in_workspace[path]
      return hit unless hit.nil?
      ok = false
      if path && @root && !path.start_with?('<') && !path.start_with?('(')
        full = canonical(path)
        if full.start_with?("#{@root}/") || full.start_with?("#{@root}\\")
          rel = full[(@root.length + 1)..-1]
          ok = (rel.split(%r{[/\\]}) & EXCLUDE_PARTS).empty?
        end
      end
      @in_workspace[path] = ok
    end

    def function(key, path, name, line)
      f = @functions[key]
      return f if f
      return nil if @functions.size >= MAX_FUNCTIONS
      @functions[key] = [path, name, line, 0, 0, 0.0]
    end

    def watch_for(key, path, name, line)
      return @watched[key] if @watched.key?(key)
      specs = @watch_specs.fetch(canonical(path), nil)
      rec = nil
      if specs
        hit = specs.find { |s| s[:symbol] == '*' } ||
              specs.find do |s|
                s[:symbol] == name &&
                  (s[:line_start].zero? || (line >= s[:line_start] - 1 && line <= [s[:line_end], s[:line_start]].max))
              end
        named = specs.select { |s| s[:symbol] == name }
        hit ||= named.first if named.size == 1
        rec = WatchRecord.new(path, name, line) if hit
      end
      @watched[key] = rec
    end

    def stack
      Thread.current[:__ambio_recorder_stack] ||= []
    end

    # The exception currently unwinding this thread, if any.
    def in_flight
      Thread.current[:__ambio_recorder_in_flight]
    end

    def in_flight=(exception)
      Thread.current[:__ambio_recorder_in_flight] = exception
    end

    def on_call(tp)
      # Code running again means the exception was handled (or swallowed in
      # C, which fires no :rescue). An ensure clause that calls a method stops
      # the marking there; the method that raised is still marked.
      self.in_flight = nil if in_flight
      path = tp.path
      return unless workspace?(path)
      name = tp.method_id.to_s
      line = tp.lineno
      key = "#{path}:#{line}:#{name}"
      frames = stack
      @lock.synchronize do
        f = function(key, path, name, line)
        return unless f
        f[3] += 1
        caller_frame = frames.last
        if caller_frame && caller_frame[:key] != key
          edge = [caller_frame[:key], key]
          if @edges.key?(edge)
            @edges[edge] += 1
          elsif @edges.size < MAX_EDGES
            @edges[edge] = 1
          else
            @edges_dropped += 1
          end
        end
        state = { key: key, f: f, t0: Process.clock_gettime(Process::CLOCK_MONOTONIC), exc: nil, w: nil }
        w = watch_for(key, path, name, line)
        if w
          w.calls += 1
          names = []
          values = []
          binding = tp.binding
          tp.parameters.each do |kind, pname|
            next if pname.nil? || kind == :block
            begin
              values << binding.local_variable_get(pname)
              names << pname.to_s
            rescue StandardError
              next
            end
          end
          before = {}
          names.zip(values).each do |n, v|
            AmbioRecorder.flatten(v, n).each do |p, l|
              before[p] = l
              w.observe("arg.#{p}", l)
            end
          end
          nodes = []
          names.zip(values).each { |n, v| AmbioRecorder.collect_nodes(v, n, nodes) }
          w.check_drift(nodes, w.calls)
          args_preview = AmbioRecorder.preview(Hash[names.map(&:to_sym).zip(values)])
          fingerprint = before.map { |p, l| "#{p}=#{AmbioRecorder.display(l)}" }.join('|')
          w.observe_args(w.calls, names, values, fingerprint, args_preview)
          state[:w] = { rec: w, names: names, values: values, before: before, call: w.calls, args: args_preview }
        end
        frames.push(state)
      end
    end

    def on_raise(tp)
      # Kernel#loop and external enumerators end iteration with StopIteration,
      # rescued inside C: control flow, not a failure.
      return if tp.raised_exception.is_a?(StopIteration)

      self.in_flight = tp.raised_exception
      top = stack.last
      top[:exc] = tp.raised_exception if top
    end

    def on_rescue(_tp)
      self.in_flight = nil
      top = stack.last
      top[:exc] = nil if top
    end

    def on_return(tp)
      frames = stack
      return if frames.empty?
      key = "#{tp.path}:#{tp.lineno}:#{tp.method_id}"
      # :return reports the method's current line, not its def line: match the
      # frame by method and file instead of by key.
      state = frames.last
      return unless state && state[:key].end_with?(":#{tp.method_id}") && state[:key].start_with?("#{tp.path}:")
      frames.pop
      value = tp.return_value
      @lock.synchronize do
        ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - state[:t0]) * 1000.0
        f = state[:f]
        f[5] += ms
        threw = nil
        exc = state[:exc] || in_flight
        if exc && value.nil?
          threw = "#{exc.class.name}: #{exc.message.to_s[0, 200]}"
          f[4] += 1
        elsif !value.nil?
          self.in_flight = nil
        end
        w = state[:w]
        record_watch(w, value, threw, ms) if w
      end
      key
    end

    def record_watch(w, value, threw, ms)
      rec = w[:rec]
      rec.total_ms += ms
      if threw
        rec.errors += 1
        rec.exceptions[threw] = (rec.exceptions[threw] || 0) + 1 if rec.exceptions.size < MAX_EXCEPTIONS || rec.exceptions.key?(threw)
      else
        whole = AmbioRecorder.preview(value)
        rec.returns.add(value.is_a?(Numeric) ? ['number', value] : ['text', whole.length <= 80 ? whole : "#{whole[0, 79]}…"])
        AmbioRecorder.flatten(value, 'return').each { |p, l| rec.observe(p, l) }
        # What a method hands back can be changed behind its back too: a cache
        # returning the same object, altered since it last returned it.
        if AmbioRecorder.leaf(value).nil?
          returned = []
          AmbioRecorder.collect_nodes(value, 'return', returned)
          rec.check_drift(returned, w[:call])
        end
      end
      changed = []
      w[:names].zip(w[:values]).each do |n, v|
        after = AmbioRecorder.flatten(v, n)
        keys = w[:before].keys.select { |k| k == n || k.start_with?("#{n}.") || k.start_with?("#{n}[") }
        keys += after.keys.reject { |k| w[:before].key?(k) }
        keys.each do |k|
          b = AmbioRecorder.display(w[:before][k])
          a = AmbioRecorder.display(after[k])
          changed << [k, b, a] if a != b
        end
      end
      changed.first(20).each { |path, b, a| rec.mutation(path, b, a, w[:call]) }
      after_nodes = []
      w[:names].zip(w[:values]).each { |n, v| AmbioRecorder.collect_nodes(v, n, after_nodes) }
      rec.check_drift(after_nodes, w[:call])
      sample = { 'call' => w[:call], 'args' => w[:args], 'ms' => ms.round(3) }
      if threw
        sample['threw'] = threw
      else
        sample['returned'] = AmbioRecorder.preview(value)
      end
      sample['mutated'] = changed.first(4).map { |p, b, a| "#{p}: #{b} → #{a}" } unless changed.empty?
      rec.sample(sample)
    end

    def uncaught(error)
      return if @uncaught.size >= 5 || error.nil? || error.is_a?(SystemExit)
      frames = (error.backtrace || []).first(12).map do |line|
        file, lineno, where = line.split(':', 3)
        name = where.to_s[/`([^']+)'/, 1] || where.to_s[/'([^']+)'/, 1] || '?'
        "    at #{name} (#{canonical(File.expand_path(file.to_s, @cwd))}:#{lineno.to_i}:1)"
      end
      @lock.synchronize do
        @uncaught << { 'what' => "#{error.class.name}: #{error.message.to_s[0, 300]}", 'stack' => frames.join("\n") }
      end
    end

    def write
      return unless @dir
      doc = nil
      @lock.synchronize do
        total = @functions.values.sum { |f| f[3] } + @uncaught.size
        return if total == @last_written
        @last_written = total
        return if @functions.empty? && @uncaught.empty?
        by_key = @functions
        ref = lambda do |key|
          f = by_key[key]
          { 'file' => canonical(f[0]), 'name' => f[1], 'line' => f[2] }
        end
        doc = {
          'version' => 1,
          'runId' => @run_id,
          'pid' => Process.pid,
          'argv' => [File.basename($PROGRAM_NAME.to_s)] + ARGV.first(2).map { |a| File.basename(a) },
          'startedAt' => @started,
          'endedAt' => (Time.now.to_f * 1000).to_i,
          'functions' => @functions.values.map do |f|
            { 'file' => canonical(f[0]), 'name' => f[1], 'line' => f[2], 'calls' => f[3], 'errors' => f[4], 'ms' => f[5].round(3) }
          end,
          'edges' => @edges.map { |(a, b), n| { 'from' => ref.call(a), 'to' => ref.call(b), 'calls' => n } },
          'edgesDropped' => @edges_dropped,
          'watched' => @watched.values.compact.map { |r| h = r.to_h; h['file'] = canonical(h['file']); h },
          'uncaught' => @uncaught
        }
      end
      Dir.mkdir(@dir) unless Dir.exist?(@dir)
      tmp = File.join(@dir, "#{Process.pid}.json.tmp")
      File.write(tmp, JSON.generate(doc))
      File.rename(tmp, File.join(@dir, "#{Process.pid}.json"))
    rescue StandardError
      nil
    end
  end

  def start
    dir = ENV['AMBIO_EVIDENCE_DIR']
    return nil if dir.nil? || dir.empty? || @recorder
    watches = begin
      JSON.parse(ENV['AMBIO_WATCHES'] || '[]')
    rescue StandardError
      []
    end
    rec = Recorder.new(dir, ENV['AMBIO_RUN_ID'].to_s, ENV['AMBIO_WORKSPACE_ROOT'] || Dir.pwd, watches)
    @recorder = rec
    events = %i[call return raise]
    events << :rescue if RESCUE_EVENT
    trace = TracePoint.new(*events) do |tp|
      begin
        case tp.event
        when :call then rec.on_call(tp)
        when :return then rec.on_return(tp)
        when :raise then rec.on_raise(tp)
        when :rescue then rec.on_rescue(tp)
        end
      rescue StandardError
        nil
      end
    end
    at_exit do
      trace.disable
      rec.uncaught($!) if $!
      rec.write
    end
    # A killed process (timeout) skips at_exit; flush periodically.
    flusher = Thread.new do
      loop do
        sleep 1
        rec.write
      end
    end
    flusher.report_on_exception = false if flusher.respond_to?(:report_on_exception=)
    trace.enable
    rec
  rescue StandardError
    nil
  end
end

AmbioRecorder.start
